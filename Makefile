BINARY := seme
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build web-build test lint vet fmt run docker clean mac-app

mac-app:
	VERSION="$(VERSION)" ./scripts/build-macos.sh

build: web-build
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/seme

go-build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/seme

web-build:
	cd web && npm run build

test:
	go test -race -cover ./...

vet:
	go vet ./...

lint:
	golangci-lint run

fmt:
	gofmt -w .

run:
	go run ./cmd/seme --config ./config.yaml

docker:
	docker build -t seme:latest .

clean:
	rm -rf bin coverage.out
