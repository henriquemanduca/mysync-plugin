PLUGIN_ID := mysync
OBSIDIAN_VAULTS := /home/henrique/projetos/pessoal/note-brain /home/henrique/projetos/pessoal/note-brain-out

.PHONY: major patch build deploy

patch:
	npm version patch

major:
	npm version major

build:
	npm run build

deploy: build
	@for vault in $(OBSIDIAN_VAULTS); do \
		plugin_dir="$$vault/.obsidian/plugins/$(PLUGIN_ID)"; \
		mkdir -p "$$plugin_dir"; \
		cp dist/main.js "$$plugin_dir/main.js"; \
		cp dist/manifest.json "$$plugin_dir/manifest.json"; \
		cp dist/styles.css "$$plugin_dir/styles.css"; \
	done
