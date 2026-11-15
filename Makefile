NODE ?= node

.PHONY: build test check clean integration-test integration-app mac-app

build:
	./scripts/build-stremio-integration.sh

test:
	$(NODE) --test stremio-integration/test/*.test.cjs

check:
	@for source in stremio-integration/*.cjs stremio-integration/lib/*.cjs; do $(NODE) --check "$$source" || exit; done
	bash -n scripts/build-stremio-integration.sh

# Keep existing integration commands and the macOS build shortcut working.
integration-test: test
integration-app mac-app: build

clean:
	rm -rf -- "dist/Sème Setup.app" "dist/Seme-Stremio-Integration-macos.zip"
