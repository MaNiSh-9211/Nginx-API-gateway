# Common operations — run from dev/ directory
# Windows: use `make` via WSL/Git Bash, or run docker/cargo commands directly.

.PHONY: build up down test test-unit test-all logs ps rebuild validate

build:
	docker compose -f docker-compose.yml up --build -d

up:
	docker compose -f docker-compose.yml up -d --build

down:
	docker compose -f docker-compose.yml down

ps:
	docker compose -f docker-compose.yml ps

logs:
	docker compose -f docker-compose.yml logs -f gateway control-plane config-sidecar

rebuild:
	docker compose -f docker-compose.yml build gateway config-sidecar control-plane
	docker compose -f docker-compose.yml up -d

test:
	powershell -ExecutionPolicy Bypass -File test.ps1

test-unit:
	cd ../gateway-edge/rust-ext && cargo test --release
	cd ../gateway-control-plane && cargo test --release
	cd ../gateway-sidecar && cargo test --release

test-all: validate test-unit test test-uam
	@echo "All tests passed."

test-uam:
	powershell -ExecutionPolicy Bypass -File scripts/test-uam.ps1

validate:
	docker compose -f docker-compose.yml config --quiet
	docker compose -f docker-compose.multi-region.yml config --quiet

chaos:
	powershell -ExecutionPolicy Bypass -File tests/chaos_test.ps1

load:
	powershell -ExecutionPolicy Bypass -File scripts/load-test.ps1

release-check:
	powershell -ExecutionPolicy Bypass -File scripts/release-check.ps1

release-check-sh:
	chmod +x scripts/release-check.sh tests/e2e.sh && ./scripts/release-check.sh

e2e-sh:
	chmod +x tests/e2e.sh && ./tests/e2e.sh

release-check-fast:
	powershell -ExecutionPolicy Bypass -File scripts/release-check.ps1 -SkipE2E
