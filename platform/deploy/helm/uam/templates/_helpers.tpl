{{- define "uam.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "uam.namespace" -}}
{{- .Values.namespace }}
{{- end }}

{{- define "uam.labels" -}}
helm.sh/chart: {{ include "uam.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "uam.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "uam.mongodbUri" -}}
mongodb://{{ .Values.secrets.mongoRootUser }}:{{ .Values.secrets.mongoRootPassword }}@mongodb:27017/uam?authSource=admin
{{- end }}
