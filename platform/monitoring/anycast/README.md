# Anycast / GeoDNS Global Traffic Distribution

## Overview

Trillion-RPS requires traffic to enter at the nearest PoP worldwide.
This directory documents the two standard approaches and provides
configuration templates for each.

---

## Option A — Cloudflare Anycast (Recommended)

Cloudflare operates 300+ PoPs with Anycast routing built in.
Your gateway nodes sit behind Cloudflare as "origin servers".

### Setup

1. Point your domain's nameservers to Cloudflare.
2. Create DNS A records for each region's gateway cluster:
   ```
   api.example.com  →  Cloudflare proxy (orange cloud ON)
   ```
3. Use Cloudflare Load Balancing with geo-steering:
   - Pool `eu-pool`  → gateway nodes in eu-central-1
   - Pool `us-pool`  → gateway nodes in us-east-1
   - Pool `ap-pool`  → gateway nodes in ap-southeast-1
4. Enable "Proximity Steering" — routes to nearest healthy pool.
5. Set health check: `GET /health` → expect `{"status":"healthy"}`.

### Cloudflare Load Balancer config (Terraform)

```hcl
resource "cloudflare_load_balancer" "gateway" {
  zone_id          = var.zone_id
  name             = "api.example.com"
  default_pool_ids = [cloudflare_load_balancer_pool.us.id]
  fallback_pool_id = cloudflare_load_balancer_pool.us.id
  steering_policy  = "proximity"

  pop_pools {
    pop      = "EWR"  # New York
    pool_ids = [cloudflare_load_balancer_pool.us.id]
  }
  pop_pools {
    pop      = "LHR"  # London
    pool_ids = [cloudflare_load_balancer_pool.eu.id]
  }
  pop_pools {
    pop      = "SIN"  # Singapore
    pool_ids = [cloudflare_load_balancer_pool.ap.id]
  }
}

resource "cloudflare_load_balancer_pool" "eu" {
  name    = "eu-pool"
  origins {
    name    = "eu-gateway-1"
    address = "10.0.1.10"  # private IP of EU gateway node
    enabled = true
  }
  health_check_id = cloudflare_load_balancer_monitor.health.id
}
```

---

## Option B — AWS Route 53 Latency-Based Routing

Use Route 53 latency records to route users to the nearest region.

```hcl
resource "aws_route53_record" "gateway_eu" {
  zone_id        = var.zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "eu-central-1"

  latency_routing_policy {
    region = "eu-central-1"
  }

  alias {
    name                   = aws_lb.gateway_eu.dns_name
    zone_id                = aws_lb.gateway_eu.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "gateway_us" {
  zone_id        = var.zone_id
  name           = "api.example.com"
  type           = "A"
  set_identifier = "us-east-1"

  latency_routing_policy {
    region = "us-east-1"
  }

  alias {
    name                   = aws_lb.gateway_us.dns_name
    zone_id                = aws_lb.gateway_us.zone_id
    evaluate_target_health = true
  }
}
```

---

## Option C — BGP Anycast (Self-hosted, advanced)

For operators running their own ASN:

1. Announce the same IP prefix (e.g. `203.0.113.0/24`) from all PoPs via BGP.
2. Internet routing naturally sends users to the nearest PoP (shortest AS path).
3. Use BIRD or FRRouting as the BGP daemon on each gateway node.

```
# /etc/bird/bird.conf (per gateway node)
router id 203.0.113.1;

protocol bgp upstream {
    local as 65001;
    neighbor 198.51.100.1 as 65000;
    export filter {
        if net = 203.0.113.0/24 then accept;
        reject;
    };
}
```

---

## Multi-Region Docker Compose

For testing multi-region locally, use the provided
`docker-compose.multi-region.yml` which starts three gateway
instances simulating EU, US, and AP regions.

```bash
docker-compose -f docker-compose.multi-region.yml up -d
```
