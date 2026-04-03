# vscode-llmlet: LLM and Terminal inside VSCode for the Web

An extension for VSCode for the Web to run an LLM and a Linux-based terminal fully inside browser.

This is experimental software.
See [remaining issues](#remaining-issues).

## Features

- Running LLM models in the browser using Wasm/WebGPU with [a Wasm-compiled llama.cpp](https://github.com/ggml-org/llama.cpp/blob/10e9780154365b191fb43ca4830659ef12def80f/docs/build.md#webgpu-in-progress)
- Terminal with a Linux-based container running inside browser's Wasm VM using [container2wasm](https://github.com/container2wasm/container2wasm)
- P2P distributed LLM inference among browsers connected via WebRTC using [LLMlet](https://github.com/ktock/llmlet)
- Allowing the LLM model to access the workspace and the terminal

## Quick Start

1. Open the `ktock/vscode-llmlet-gcc-example` repo on `github.dev`: https://github.dev/ktock/vscode-llmlet-gcc-example?vscode-coi=on (you need the `?vscode-coi=on` query in the URL)
2. Install the `ktock.llmlet` extension.
3. Open the `LLMLET` panel and enter a prompt describing tasks.

Example task prompt to make a mini "uname" command in C:

```
Write a small C program mini_uname.c that calls the uname() syscall of <sys/utsname.h>, gets the "struct utsname" data, and prints the kernel name contained in the sysname field of the struct.

Test it in the following steps.

- Compile it using gcc -o /tmp/a.out /workspace/<workspace-name>/mini_uname.c
- Run it and check if the kernel name printed by the program matches to the real uname command output.
```

![Mini uname example](./images/mini-uname-example.png)

> NOTE: See the `OUTPUT` panel for the progress.
> NOTE: A single browser is capable of running only small models such as qwen3.5 4b or smaller, so they might fail to complete complex tasks. Use the [distributed inference feature](#distributed-inference-among-browsres) to run a larger model on multiple browsers.

## Available Panels

### `LLMLET` panel 

It displays a chat session with the model.

Specify the URL of the GGUF model to run in `llmlet.model`.
The default value is [Qwen3.5 4B GGUF format by unsloth](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF).
You might need sufficiently large models such as `Qwen3.5 4B` to run tasks correctly.

The model can access the files in the workspace and the terminal.

As of now, the context size is limited (default is 10240) and long tasks don't work.

### `TERMINAL` panel

It displays the terminal of a Linux-based container running inside the browser.

The workspace is read-only mounted at `/workspace` inside the container.

The container can perform HTTP/HTTPS requests with restrictions by the browser (CORS restrictions and no control over [Forbidden headers](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)).

Specify the reference of a container image in `llmlet.container.image`.
It fetches and runs the image from either of the following locations.

- An image stored in an HTTP(S) server in [OCI Image Layout](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-layout.md).
  - Example value: `https://ktock.github.io/image-gcc-alpine/oci/`
- An image stored in a container registry configured to enable CORS.
  - There is no such public registry as of March 2026. ([proposal to Docker Hub](https://github.com/docker/roadmap/issues/667). You can run a private registry with CORS enabled [as described in the contianer2wasm repo](https://github.com/container2wasm/container2wasm/tree/837933c1462fcd4e38a75a87c2a46db8af7e057f/extras/imagemounter#example-on-browser--registry).
  - Example value: `localhost:5000/ubuntu:24.04`

### `OUTPUT` panel

It displays logs from vscode-llmlet for monitoring and debugging the extension.

Ensure "LLMlet" is selected in the panel.

## Distributed inference among browsers

To run a model larger than the memory capacity of a single browser, you can use multiple browsers connected over WebRTC (PeerJS).

Refer to [ktock/vscode-llmlet-gcc-example](https://github.com/ktock/vscode-llmlet-gcc-example) for a step-by-step example.

On all browsers, open vscode-llmlet, set `llmlet.peer.enabled` to true, and reload the tab to enable this feature.
Each browser displays its Peer ID as a message `[peer] Peer ID: <peerid>` in the `OUTPUT` panel.
On each browser, write the comma-separeted list of all peer IDs to `llmlet.peer.peers`.

When starting an LLM chat in a peer, the model is split in layer granularity and distributed to peers.

> NOTE
> - As of now we don't offer the TURN server so peers can't connect each other if they are in network environments that don't allow P2P communication.
> - vscode-llmlet uses the [PeerJS's public server](https://peerjs.com/server/cloud) for establishing the connection among peers by default. You can change the server using `llmlet.peer.peerServer`.

## Extension Settings

- `llmlet.model` *string* : URL of the model (GGUF format) to use (default: `https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q3_K_M.gguf`)
- `llmlet.quiet` *boolean* : Suppress raw output from the model (default: false)
- `llmlet.contextSize` *integer* : Context size (default: 10240)
- `llmlet.ubatchSize` *integer* : Ubatch size (default: 96)
- `llmlet.enableWebGPU` *boolean* : Use WebGPU if available (default: true)
- `llmlet.container.image` *string* : URL of the container image to use (example value: Alpine + gcc: `https://ktock.github.io/image-gcc-alpine/oci/`) (default: "")
- `llmlet.container.workspaceMountpoint` : *string* : Path to mount workspaces (default: "/workspace")
- `llmlet.peer.enabled` *boolean* : Enable to connect with other peers (default: false)
- `llmlet.peer.peers` *string* : Other peers to connect to / accept (comma or newline separated) (default: `[]`)
- `llmlet.peer.peerServer` *string* : Address to the PeerJS signaling server. Empty means [PeerJS's public server](https://peerjs.com/server/cloud). (default: "")

Use `.vscode/settings.json` to set values specific to the workspace (e.g. container image for development).

## How it works

- LLM runner: Uses a Wasm-compiled llama.cpp with patches to enable P2P distributed inference among browsers connected via WebRTC. For details, see the [LLMlet](https://github.com/ktock/llmlet) repo.
- Terminal: Runs a x86_64 Linux-based container on a [Wasm-compiled QEMU](https://github.com/ktock/qemu-wasm) running inside browser. For defailts, see the [container2wasm](https://github.com/container2wasm/container2wasm) repo.
- Networking: NW stack runs inside the browser and uses the browser's Fetch API to enable HTTP(S) networking from the terminal. For details see also [the docs in container2wasm](https://github.com/container2wasm/container2wasm/tree/b92728c5fb64385f56aff48bfd1f873864c334af/examples/networking/fetch).

## Remaining issues

- Context size is limited (10240 by default) so not great for long tasks.
- Parallelism is not yet supported in P2P distributed inference.
- The default setting relies on PeerJS's public server. The [TURN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols#turn) service for relaying packets among peers is not provided. So peers can't connect to each other if they are in network environments that don't allow P2P communication.

## Troubleshooting

### "SharedArrayBuffer is not defined" error occurs when launching the container

Add the `?vscode-coi=on` query to the URL and reload to make SharedArrayBuffer available.

### Inference speed is slow

Try tweaking settings such as `llmlet.ubatchSize` or `llmlet.enableWebGPU`, or try smaller models.
You can also run it on a device with faster processors.

### Chat session doesn't start with errors

Sometimes clearing the browser cache might fix the issue.
Open an issue if you find that models don't start.
