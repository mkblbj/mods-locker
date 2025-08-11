# Simple pipeline to reverse Modium-like Electron apps

SHELL := /usr/bin/bash
NODE := node
NPM := npm

WORKDIR := $(CURDIR)/reverse/modium
EXTRACTED := $(WORKDIR)/extracted
UNPACKED := $(WORKDIR)/unpacked
STATE := $(WORKDIR)/target.txt

.PHONY: help setup reverse hook analyze analyze_native repack clean

help:
	@echo "Targets:"
	@echo "  setup               Install local dev dependencies (asar, prettier)"
	@echo "  reverse INSTALLER=|ASAR=|APPDIR=  Unpack from installer, asar file, or installed app dir"
	@echo "  hook                Inject logging hook into main process"
	@echo "  analyze             Static scan endpoints/ipc and export JSON"
	@echo "  repack              Repack unpacked directory back into app.asar"
	@echo "  clean               Remove reverse workspace"
	@echo "  cli                 Run automation CLI (see scripts/modium/cli.js)"

setup:
	$(NPM) install --silent

reverse:
	@test -n "$(INSTALLER)$(ASAR)$(APPDIR)" || (echo "ERROR: provide one of INSTALLER=... | ASAR=... | APPDIR=..." && exit 1)
	bash scripts/modium/reverse.sh "$(if $(INSTALLER),$(INSTALLER),$(if $(ASAR),$(ASAR),$(APPDIR)))"

hook:
	$(NODE) scripts/modium/inject.js

analyze:
	$(NODE) scripts/modium/analyze.js

analyze_native:
	$(NODE) scripts/modium/analyze_native.js

repack:
	bash scripts/modium/repack.sh

cli:
	node scripts/modium/cli.js --help

clean:
	rm -rf $(WORKDIR)

