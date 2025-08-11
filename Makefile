# Simple pipeline to reverse Modium-like Electron apps

SHELL := /usr/bin/bash
NODE := node
NPM := npm

WORKDIR := $(CURDIR)/reverse/modium
EXTRACTED := $(WORKDIR)/extracted
UNPACKED := $(WORKDIR)/unpacked
STATE := $(WORKDIR)/target.txt

.PHONY: help setup reverse hook analyze repack clean

help:
	@echo "Targets:"
	@echo "  setup               Install local dev dependencies (asar, prettier)"
	@echo "  reverse INSTALLER=|ASAR=|APPDIR=  Unpack from installer, asar file, or installed app dir"
	@echo "  hook                Inject logging hook into main process"
	@echo "  analyze             Static scan endpoints/ipc and export JSON"
	@echo "  repack              Repack unpacked directory back into app.asar"
	@echo "  clean               Remove reverse workspace"

setup:
	$(NPM) install --silent

reverse:
	@test -n "$(INSTALLER)$(ASAR)$(APPDIR)" || (echo "ERROR: provide one of INSTALLER=... | ASAR=... | APPDIR=..." && exit 1)
	bash scripts/modium/reverse.sh "$(if $(INSTALLER),$(INSTALLER),$(if $(ASAR),$(ASAR),$(APPDIR)))"

hook:
	$(NODE) scripts/modium/inject.js

analyze:
	$(NODE) scripts/modium/analyze.js

repack:
	bash scripts/modium/repack.sh

clean:
	rm -rf $(WORKDIR)

