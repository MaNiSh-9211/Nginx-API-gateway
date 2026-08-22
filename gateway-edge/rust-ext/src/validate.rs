//! Request validation — per-route body policy (ADR-0064).
//!
//! WAF blocks *attacks*; this module blocks *malformed-but-benign* traffic
//! before it ever reaches a backend: size caps, JSON content-type
//! enforcement, and required top-level fields with primitive types.
//!
//! Deliberately NOT full JSON Schema — the 80/20 is catching missing/mistyped
//! fields and wrong content types, which is where most backend 400 noise
//! comes from. Pure functions; zero I/O; hot-path cost ≈ one parse of an
//! already-in-memory body only for routes that opt in.

use serde::Deserialize;

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct ValidationConfig {
    /// Reject bodies larger than this with 413.
    #[serde(default)]
    pub max_body_bytes: Option<usize>,
    /// Bodies on JSON routes must declare application/json (415 otherwise).
    #[serde(default)]
    pub require_json: bool,
    /// Required top-level members and their primitive types.
    #[serde(default)]
    pub required: Vec<RequiredField>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct RequiredField {
    pub field: String,
    pub r#type: FieldType,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    Object,
    Array,
}

impl FieldType {
    fn matches(&self, v: &serde_json::Value) -> bool {
        match self {
            FieldType::String => v.is_string(),
            FieldType::Number => v.is_number(),
            FieldType::Boolean => v.is_boolean(),
            FieldType::Object => v.is_object(),
            FieldType::Array => v.is_array(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Violation {
    TooLarge { actual: usize, limit: usize },
    NotJson,
    MissingField(String),
    WrongType { field: String, expected: &'static str },
}

impl Violation {
    /// HTTP status + machine-readable reason for the gateway error path.
    pub fn response(&self) -> (u16, String) {
        match self {
            Violation::TooLarge { limit, .. } => (413, format!("body exceeds {} bytes", limit)),
            Violation::NotJson => (415, "content-type must be application/json".into()),
            Violation::MissingField(f) => (400, format!("missing field '{f}'")),
            Violation::WrongType { field, expected } => {
                (400, format!("field '{field}' must be {expected}"))
            }
        }
    }
}

/// Validate a request body against the route policy.
/// `content_type` is the raw Content-Type header value ('' when absent).
pub fn validate_body(
    cfg: &ValidationConfig,
    content_type: &str,
    body: &str,
) -> Result<(), Violation> {
    if let Some(limit) = cfg.max_body_bytes {
        let actual = body.len();
        if actual > limit {
            return Err(Violation::TooLarge { actual, limit });
        }
    }

    let trimmed = body.trim();
    if trimmed.is_empty() {
        // Nothing to validate — presence requirements apply to JSON payloads;
        // empty bodies are the caller's design choice (e.g. GET-like POSTs).
        return Ok(());
    }

    if cfg.require_json && !content_type.trim().to_ascii_lowercase().starts_with("application/json")
    {
        return Err(Violation::NotJson);
    }

    if !cfg.required.is_empty() {
        let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => return Err(Violation::NotJson),
        };
        if !parsed.is_object() {
            return Err(Violation::NotJson);
        }
        for req in &cfg.required {
            match parsed.get(req.field.as_str()) {
                None | Some(serde_json::Value::Null) => {
                    return Err(Violation::MissingField(req.field.clone()));
                }
                Some(v) if !req.r#type.matches(v) => {
                    return Err(Violation::WrongType {
                        field: req.field.clone(),
                        expected: type_name(req.r#type),
                    });
                }
                Some(_) => {}
            }
        }
    }

    Ok(())
}

fn type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::String => "a string",
        FieldType::Number => "a number",
        FieldType::Boolean => "a boolean",
        FieldType::Object => "an object",
        FieldType::Array => "an array",
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(required: &[(&str, FieldType)], max: Option<usize>, need_json: bool) -> ValidationConfig {
        ValidationConfig {
            max_body_bytes: max,
            require_json: need_json,
            required: required
                .iter()
                .map(|(f, t)| RequiredField { field: f.to_string(), r#type: *t })
                .collect(),
        }
    }

    const CT_JSON: &str = "application/json; charset=utf-8";

    #[test]
    fn accepts_valid_payload() {
        let c = cfg(&[("email", FieldType::String), ("age", FieldType::Number)], None, true);
        assert!(validate_body(&c, CT_JSON, r#"{"email":"a@b.c","age":3}"#).is_ok());
    }

    #[test]
    fn rejects_missing_field() {
        let c = cfg(&[("email", FieldType::String)], None, true);
        assert_eq!(
            validate_body(&c, CT_JSON, r#"{"name":"x"}"#),
            Err(Violation::MissingField("email".into()))
        );
    }

    #[test]
    fn rejects_null_as_missing() {
        let c = cfg(&[("email", FieldType::String)], None, true);
        assert_eq!(
            validate_body(&c, CT_JSON, r#"{"email":null}"#),
            Err(Violation::MissingField("email".into()))
        );
    }

    #[test]
    fn rejects_wrong_type() {
        let c = cfg(&[("age", FieldType::Number)], None, true);
        assert_eq!(
            validate_body(&c, CT_JSON, r#"{"age":"old"}"#),
            Err(Violation::WrongType { field: "age".into(), expected: "a number" })
        );
    }

    #[test]
    fn rejects_wrong_content_type_when_required() {
        let c = cfg(&[("email", FieldType::String)], None, true);
        assert_eq!(
            validate_body(&c, "text/plain", r#"{"email":"a@b.c"}"#),
            Err(Violation::NotJson)
        );
    }

    #[test]
    fn rejects_invalid_json_when_fields_required() {
        let c = cfg(&[("email", FieldType::String)], None, true);
        assert_eq!(validate_body(&c, CT_JSON, "{not-json"), Err(Violation::NotJson));
    }

    #[test]
    fn empty_body_passes_field_checks() {
        let c = cfg(&[("email", FieldType::String)], None, true);
        assert!(validate_body(&c, "", "").is_ok());
    }

    #[test]
    fn size_limit_enforced_before_parse() {
        let c = cfg(&[], Some(10), false);
        let big = "x".repeat(11);
        assert!(matches!(
            validate_body(&c, "", &big),
            Err(Violation::TooLarge { actual: 11, limit: 10 })
        ));
    }

    #[test]
    fn no_policy_accepts_everything() {
        let c = cfg(&[], None, false);
        assert!(validate_body(&c, "text/plain", "anything at all").is_ok());
    }
}
