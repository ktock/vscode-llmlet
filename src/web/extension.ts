import * as vscode from 'vscode';
import { applyPatch } from 'diff';

export function activate(context: vscode.ExtensionContext) {
    const provider = new LLMletViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'llmlet.view',
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true }
            }
        ),
    );
}

export function deactivate() {}

class LLMletViewProvider implements vscode.WebviewViewProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}
    
    public resolveWebviewView(webviewView: vscode.WebviewView) {
        const webview = webviewView.webview;
        webview.options = {
            enableScripts: true,
        };

        let vendorTargets: string[] = [
            'llmlet.js',
            'llmlet-mod.js',
            'llmlet-mod.wasm',
            'out.js',
            'qemu-system-x86_64.wasm',
            'load.js',
            'qemu-system-x86_64.data',
            'arg-module.js',
            'runcontainer.js',
            'stack-worker.js',
            'imagemounter.wasm.gzip'
        ];
        let vendorFiles: Record<string, string> = {};
        for (const f of vendorTargets) {
            vendorFiles[f] = webview.asWebviewUri(
                vscode.Uri.joinPath(this.context.extensionUri, 'media/vendor', f)
            ).toString();
        }
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media/script.js')
        ).toString();
        const vendorFilesMapStr = JSON.stringify(vendorFiles);

        webview.html = `
<!DOCTYPE html>
<html>
<head>
<title>LLMlet</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-rbsA2VBKQhggwzxH7pPCaAqO46MgnOM80zW1RWuH61DGLwZJEdK2Kadq2F9CUG65" crossorigin="anonymous">
</head>
<body class="bg-black">

<div class="vh-100 d-flex flex-column overflow-hidden">
<div id="output" class="p-3 my-3 bg-black border border-white text-white text-break font-monospace overflow-y-auto flex-grow-1" style="scrollbar-width: thin; scrollbar-color: #ffffff #000000; white-space: pre-wrap; overflow-x: hidden; font-size: 0.9rem;"></div>
<div class="input-group mb-3">
<textarea id="promptMessage" class="form-control bg-black text-white" style="overflow: hidden; resize: none;" placeholder="Ask anything" rows="1"></textarea>
<div class="input-group-append">
<button id="doPromptButton" class="btn btn-black border-white text-white btn-outline-secondary">Enter</button>
<button id="cancelButton" class="btn btn-black border-white text-white btn-outline-secondary">Cancel</button>
</div>
</div>
<p id="log-message" class="bg-black font-size: 0.8rem;" style="color: gray; white-space: nowrap; overflow: hidden;"></p>
</div>

<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
<script src="${vendorFiles['llmlet.js']}"></script>
<script>
const vendorFiles = ${vendorFilesMapStr};
</script>
<script src="${vendorFiles['runcontainer.js']}"></script>
<script type="module" src="${scriptUri}">
</script>

</body>
</html>
`

        let isTerminalOpen = false;
        const writeEmitter = new vscode.EventEmitter<string>();
        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            open: () => {},
            close: () => {
                isTerminalOpen = false;
            },
            handleInput: data => webview.postMessage({
                type: 'term/input',
                data: data,
            }),
            setDimensions: dims => webview.postMessage({
                type: 'term/resize',
                cols: dims.columns,
                rows: dims.rows,
            }),
        };

        vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            webview.postMessage({
                type: 'fs/onChangeWorkspaceFolders',
                added: event.added,
                removed: event.removed,
            })
        });
        async function postFSEvent(type: string, uri: vscode.Uri, needsStat: boolean){
            const ws = vscode.workspace.getWorkspaceFolder(uri);
            if (!ws) return;
            let st: any = undefined;
            if (needsStat) {
                st = await vscode.workspace.fs.stat(uri);
            }
            webview.postMessage({
                type: type,
                workspace: ws.name,
                path: vscode.workspace.asRelativePath(uri, false),
                stat: st,
            })
        }
        const fsEventWatcher : vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        fsEventWatcher.onDidChange((uri: vscode.Uri) => postFSEvent('fs/onChange', uri, true));
        fsEventWatcher.onDidCreate((uri: vscode.Uri) => postFSEvent('fs/onCreate', uri, true));
        fsEventWatcher.onDidDelete((uri: vscode.Uri) => postFSEvent('fs/onDelete', uri, false));
        this.context.subscriptions.push(fsEventWatcher);
        webviewView.onDidDispose(() => fsEventWatcher.dispose());

        const openTerminal = () => {
            if (isTerminalOpen) {
                console.log('openTerminal is requested by the terminal which is already opened');
                return;
            }
            const t = vscode.window.createTerminal({ name: 'LLMlet terminal', pty });
            this.context.subscriptions.push(t);
            webviewView.onDidDispose(() => t.dispose());
            isTerminalOpen = true;
        }

        async function withEditConfirmation(msg: string, fn: () => Promise<void>) {
            try {
                await fn();
            } catch (e) {
                const choice = await vscode.window.showInformationMessage(
                    msg,
                    { modal: true },
                    'Yes'
                );
                if (choice !== 'Yes') {
                    throw new Error('user canceled');
                }
                await fn();
            }
        }

        const output = vscode.window.createOutputChannel('LLMlet');
        this.context.subscriptions.push(output);
        webviewView.onDidDispose(() => output.dispose());

        function getWorkspace(workspace: string) {
            if (workspace != "") {
                const workspaceFolder = vscode.workspace.workspaceFolders?.find(f => f.name == workspace);
                if (!workspaceFolder) {
                    throw new Error(`workspace folder "${workspace} not found"`);
                }
                return workspaceFolder
            }
            if (vscode.workspace.workspaceFolders?.length != 1) {
                throw new Error('No default workspace folder to open');
            }
            return vscode.workspace.workspaceFolders[0];
        }

        webview.onDidReceiveMessage(async (data) => {
            const msgType = data.type;
            const msg = data.msg;
            const requestId = data.requestId;
            try {
                let resp: any = null;
                switch (msgType) {
                    case 'workspace/list': {
                        let wslist = [];
                        for (const f of vscode.workspace.workspaceFolders ?? []) {
                            wslist.push(f.name)
                        }
                        resp  = {
                            ok: true,
                            res: wslist,
                        };
                        break;
                    }
                    case 'fs/readFile': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        resp = {
                            ok: true,
                            data: bytes,
                        };
                        break;
                    }
                    case 'fs/readDirectory': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        const arr = await vscode.workspace.fs.readDirectory(uri);
                        resp = {
                            ok: true,
                            res: arr,
                        };
                        break;
                    }
                    case 'fs/createFile': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        await withEditConfirmation(`Allow editing ${vscode.workspace.asRelativePath(uri)} from the model?`,
                                                   async () => await vscode.workspace.fs.writeFile(uri, (new TextEncoder()).encode(msg.contents)));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'fs/createDirectory': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        await withEditConfirmation(`Allow editing ${vscode.workspace.asRelativePath(uri)} from the model?`,
                                                   async () => await vscode.workspace.fs.createDirectory(uri));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'fs/stat': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        const res = await vscode.workspace.fs.stat(uri);
                        resp = {
                            ok: true,
                            res: res,
                        };
                        break;
                    }
                    case 'fs/patchFile': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        let oldText = "";
                        try {
                            const oldBytes = await vscode.workspace.fs.readFile(uri);
                            oldText = (new TextDecoder('utf-8')).decode(oldBytes);
                        } catch (e) {
                            if (!(e instanceof vscode.FileSystemError) || (e.code != 'FileNotFound')) {
                                throw e;
                            }
                        }
                        const newText = applyPatch(oldText, msg.diff);
                        if (newText === false) {
                            throw new Error('Patch could not be applied');
                        }
                        await withEditConfirmation(`Allow editing ${vscode.workspace.asRelativePath(uri)} from the model?`,
                                                   async () => await vscode.workspace.fs.writeFile(uri, (new TextEncoder()).encode(newText)));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'fs/copyFileDirectory': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const srcUri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.src_path
                        );
                        const dstUri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.dst_path
                        );
                        await withEditConfirmation(`Allow copying ${vscode.workspace.asRelativePath(srcUri)} to ${vscode.workspace.asRelativePath(dstUri)} by the model?`,
                                                   async () => await vscode.workspace.fs.copy(srcUri, dstUri));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'fs/renameFileDirectory': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const srcUri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.src_path
                        );
                        const dstUri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.dst_path
                        );
                        await withEditConfirmation(`Allow renaming ${vscode.workspace.asRelativePath(srcUri)} to ${vscode.workspace.asRelativePath(dstUri)} by the model?`,
                                                   async () => await vscode.workspace.fs.rename(srcUri, dstUri));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'fs/deleteFileDirectory': {
                        const workspaceFolder = getWorkspace(msg.workspace);
                        const uri = vscode.Uri.joinPath(
                            workspaceFolder.uri,
                            msg.path
                        );
                        await withEditConfirmation(`Allow editing ${vscode.workspace.asRelativePath(uri)} from the model?`,
                                                   async () => await vscode.workspace.fs.delete(uri));
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'term/open': {
                        openTerminal();
                        resp = {
                            ok: true,
                        };
                        break;
                    }
                    case 'config/get': {
                        const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('llmlet');
                        const v = extensionConfig.get(msg.key);
                        if (v === undefined) {
                            throw new Error(`config ${msg.key} does not exist`);
                        }
                        resp = {
                            ok: true,
                            value: v,
                        };
                        break;
                    }
                    case 'term/output': {
                        writeEmitter.fire(new TextDecoder().decode(msg.data));
                        return;
                    }
                    case 'log': {
                        output.appendLine(`${new Date().toISOString()} [LLMlet] ${msg.message}`);
                        return;
                    }
                }
                webview.postMessage({
                    type: 'response',
                    requestId: requestId,
                    resp: resp,
                });
            } catch (err: any) {
                webview.postMessage({
                    type: 'response',
                    requestId: requestId,
                    resp: {
                        ok: false,
                        error: err?.message ?? err,
                    },
                });
            }
        });
    }
}
