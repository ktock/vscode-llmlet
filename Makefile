VENDOR_OUTPUT_DIR ?= $(CURDIR)/media/vendor/

vendor: llmlet container2wasm-vm runcontainerjs

llmlet:
	mkdir -p $(VENDOR_OUTPUT_DIR) && \
	cd ./vendor/github.com/ktock/llmlet && \
	docker build --progress=plain --output type=local,dest=$(VENDOR_OUTPUT_DIR) . && \
	cp ./llmlet.js $(VENDOR_OUTPUT_DIR)

container2wasm-vm:
	mkdir -p $(VENDOR_OUTPUT_DIR) && \
	cd ./vendor/github.com/container2wasm/container2wasm && \
	make c2w && \
	./out/c2w --dockerfile=Dockerfile --assets=. --external-bundle --to-js $(VENDOR_OUTPUT_DIR)

runcontainerjs:
	mkdir -p $(VENDOR_OUTPUT_DIR) && \
	docker build --progress=plain --output type=local,dest=$(VENDOR_OUTPUT_DIR) -f ./Dockerfile.runcontainerjs ./vendor/github.com/container2wasm/container2wasm/extras/runcontainerjs && \
	cd ./vendor/github.com/container2wasm/container2wasm && \
	make imagemounter.wasm && \
	cat ./out/imagemounter.wasm | gzip > $(VENDOR_OUTPUT_DIR)/imagemounter.wasm.gzip
