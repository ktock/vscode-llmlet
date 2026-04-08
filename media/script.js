const vscode = acquireVsCodeApi();

// Helper functions

async function makeBlobUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
    const code = await res.text();
    const blob = new Blob([code], { type: "text/javascript" });
    return URL.createObjectURL(blob);
}

const output = document.getElementById('output');
function printText(target, txt) {
    target.textContent += txt;
    if (target.scrollHeight - target.clientHeight <= target.scrollTop + 70) {
        target.scrollTop = target.scrollHeight - target.clientHeight;
    }
}

// Message handler for the extension core

var curResCBMap = {};

function vscodePostMessage(type, msg, cb) {
    const rid = crypto.randomUUID();
    if (cb != null) {
        curResCBMap[rid] = cb;
    }
    const data = {
        type: type,
        requestId: rid,
        msg: msg,
    }
    vscode.postMessage(data);
}

function openTerminal(cb) {
    vscodePostMessage("term/open", {}, cb);
}

var containerInput = null;
var containerResize = null;
function activateMaster(master) {
    master.activate({
        write: (buf, callback) => {
            vscodePostMessage("term/output", {
                data: buf,
            });
            callback();
        },
        onData: (onDataCB) => containerInput = onDataCB,
        onBinary: (onDataCB) => {}, // xterm-pty passes the same callback as onData
        onResize: (onResizeCB) => containerResize = onResizeCB
    });
}

const logmessage = document.getElementById('log-message');
function logToVSCodeOutput(o) {
    logmessage.textContent = o;
    vscodePostMessage("log", {
        message: o,
    });
}

function vscodeRequest(type, req) {
    return new Promise((resolve, reject) => {
        vscodePostMessage(type, req, (resp) => {
            if (!resp.ok) {
                reject(resp.error);
            } else {
                resolve(resp);
            }
        });
    });
}

async function getExtensionConfig(key) {
    const res = await vscodeRequest("config/get", {
        key: key,
    });
    return res.value;
}

var fsEventHandlers;

window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
    case "term/input":
        if (containerInput != null) containerInput(msg.data);
        break;
    case "term/resize":
        if (containerResize != null) containerResize(msg.cols, msg.rows);
        break;
    case "fs/onChangeWorkspaceFolders":
        if (fsEventHandlers != null) fsEventHandlers.onChangeWorkspaceFolders(msg.added, msg.removed);
        break;
    case "fs/onChange":
        if (fsEventHandlers != null) fsEventHandlers.onChange(msg.workspace, msg.path, msg.stat);
        break;
    case "fs/onCreate":
        if (fsEventHandlers != null) fsEventHandlers.onCreate(msg.workspace, msg.path, msg.stat);
        break;
    case "fs/onDelete":
        if (fsEventHandlers != null) fsEventHandlers.onDelete(msg.workspace, msg.path);
        break;
    case "response":
        if (curResCBMap[msg.requestId] != null) {
            curResCBMap[msg.requestId](msg.resp);
            delete curResCBMap[msg.requestId];
        }
        break;
    default:
        console.log(`unknown message type ${msg.type}`);
    }
});

// Terminal panel

const TYPE_FILE = 1
const TYPE_DIR = 2

function removeDirRecursive(FS, path) {
    const st = FS.lstat(path);
    if (FS.isDir(st.mode) && !FS.isLink(st.mod)) {
        const entries = FS.readdir(path);
        for (const name of entries) {
            if (name === "." || name === "..") continue;
            removeDirRecursive(FS, path + "/" + name);
        }
        FS.rmdir(path);
        return;
    }
    FS.unlink(path);
}

async function syncNode(FS, ws, base, path, type, recursive) {
    // console.debug("sync: ", path);
    const wspath = (path).replace(base, '');
    if (type == TYPE_DIR) {
        FS.mkdirTree(path, 0o777);
        const entriesRes = await vscodeRequest("fs/readDirectory", {
            workspace: ws,
            path: wspath,
        });
        const entries = entriesRes.res;
        const orgEntries = FS.readdir(path);
        let orgEntriesMap = {};
        for (let i = 0; i < orgEntries.length; i++) {
            const name = orgEntries[i];
            if ((name === ".") || (name === "..")) continue;
            orgEntriesMap[name] = true;
        }
        for (let i = 0; i < entries.length; i++) {
            const name = entries[i][0];
            delete orgEntriesMap[name];
            if (recursive) {
                const ctype = entries[i][1];
                await syncNode(FS, ws, base, path + "/" + name, ctype, recursive);
            }
        }
        Object.keys(orgEntriesMap).forEach(name => {
            if (orgEntriesMap[name]) {
                // console.debug("unlink: ", path + "/" + name);
                removeDirRecursive(FS, path + "/" + name);
            }
        });
    } else if (type == TYPE_FILE) {
        let exists = false;
        try { exists = FS.lookupPath(path).node != null; } catch (e) {}
        if (!exists) {
            // console.debug("creating an entry:", name);
            FS.createFile("/", path, {}, true, true);
            FS.utime(path, 0, 0);
        }
        const stRes = await vscodeRequest("fs/stat", {
            workspace: ws,
            path: wspath,
        });
        const st = stRes.res;
        FS.utime(path, st.mtime, st.mtime);
        const readRes = await vscodeRequest("fs/readFile", {
            workspace: ws,
            path: wspath,
        });
        let data = readRes.data;
        FS.writeFile(path, data);
    } else {
        console.debug("unsupported file type to synchronize: filename=", wspath);
    }
}

import 'https://unpkg.com/xterm-pty@0.10.1/index.js';

let enableTerminal = false;
var systemOutputBuf = "";
let systemOutputDelimiter = "";
var curSystemOutputCB;
const containerImage = await getExtensionConfig('container.image');
const workspaceMountpoint = await getExtensionConfig('container.workspaceMountpoint');

if (containerImage != "") {
    logToVSCodeOutput('[container] Starting ' + containerImage);
    enableTerminal = true;
    openTerminal(async () => {
        const c2wJsBlobUri = await makeBlobUrl(vendorFiles['out.js']);
        const stackWorkerJsBlobUri = await makeBlobUrl(vendorFiles['stack-worker.js']);

        const { master, slave } = openpty();
        activateMaster(master);

        let Module = {};

        Module.pty = slave;

        Module['preRun'] = [];
        Module['preRun'].push((mod) => {
            const FS = Module.FS;
            const mountpoint = workspaceMountpoint;
            try { FS.mkdirTree(mountpoint); } catch (e) {}
            fsEventHandlers = {
                onChangeWorkspaceFolders: async (added, removed) => {
                    console.debug("onChangeWorkspaceFolders", "added:", added, "removed:", removed);
                    logToVSCodeOutput('[container] Synchronizing workspaces');
                    for (const e of added) {
                        const ws = e.name;
                        const path = mountpoint + "/" + ws;
                        logToVSCodeOutput('[container] Adding a workspace: ' + ws);
                        await syncNode(FS, ws, path, path, TYPE_DIR, true);
                    }
                    for (const e of removed) {
                        logToVSCodeOutput('[container] Removing a workspace: ' + ws);
                        try { removeDirRecursive(FS, mountpoint + "/" + e.name); } catch (e) {}
                    }
                    logToVSCodeOutput('[container] Finished synchronizing workspaces');
                },
                onChange: async (workspace, wspath, stat) => {
                    console.debug("onChangeFS", "workspace:", workspace, "wspath:", wspath, "stat", stat);
                    const base  = mountpoint + "/" + workspace;
                    const path = base + "/" + wspath;
                    await syncNode(FS, workspace, base, path, stat.type, false);
                },
                onCreate: async (workspace, wspath, stat) => {
                    console.debug("onCreateFS", "workspace:", workspace, "wspath:", wspath, "stat", stat);
                    const base  = mountpoint + "/" + workspace;
                    const path = base + "/" + wspath;
                    await syncNode(FS, workspace, base, path, stat.type, false);
                },
                onDelete: async (workspace, wspath) => {
                    console.debug("onDeleteFS", "workspace:", workspace, "wspath:", wspath);
                    const path = mountpoint + "/" + workspace + "/" + wspath;
                    removeDirRecursive(FS, path);
                }
            };
            (async () => {
                logToVSCodeOutput('[container] Initializing workspaces');
                const entriesRes = await vscodeRequest("workspace/list", {});
                const entries = entriesRes.res;
                for (const name of entries) {
                    const path = mountpoint + "/" + name;
                    logToVSCodeOutput('[container] Initializing a workspace: ' + name);
                    await syncNode(FS, name, path, path, TYPE_DIR, true);
                }
                logToVSCodeOutput('[container] Finished initializing workspaces');
            })();
        });
        Module['preRun'].push((Module) => {
            Module['TTY'].stream_ops.poll = (stream, timeout, notifyCallback) => {
                if (Module.pty.readable) {
                    return 1;
                }
                if (notifyCallback != null) {
                    notifyCallback.registerCleanupFunc(() => {
                        const i = readableCallbacks.indexOf(notifyCallback);
                        if (i != -1) readableCallbacks.splice(i, 1);
                    });
                    readableCallbacks.push(notifyCallback);
                }
                return 0;
            };
            var oldWrite = Module['TTY'].stream_ops.write;
            Module['TTY'].stream_ops.write = (stream, buffer, offset, length) => {
                if (systemOutputDelimiter != "") {
                    systemOutputBuf += String.fromCharCode(Array.from(buffer.subarray(offset, offset + length)));
                    let i = 0;
                    let includesDelim = false;
                    for (const char of systemOutputBuf) {
                        if (char == systemOutputDelimiter[i]) {
                            i++;
                            if (i == systemOutputDelimiter.length) {
                                includesDelim = true;
                                break;
                            }
                        }
                    }
                    if (includesDelim && curSystemOutputCB) {
                        curSystemOutputCB(systemOutputBuf);
                        curSystemOutputCB = null;
                    }
                }
                return oldWrite.call(oldWrite, stream, buffer, offset, length);
            }
        });

        await RunContainer.createContainerQEMUWasm(
            Module,
            c2wJsBlobUri,
            containerImage,
            stackWorkerJsBlobUri,
            vendorFiles['imagemounter.wasm.gzip'],
            vendorFiles['arg-module.js'],
            vendorFiles['load.js'],
            (path) => vendorFiles[path],
            {
                extraInfo: `mr: ${workspaceMountpoint}\n`,
                log: (l) => logToVSCodeOutput('[container] ' + l),
            }
        );
    });
} else {
    logToVSCodeOutput('[container] Container image to start is not specified.');
}

function systemCommand(command, resCB) {
    if (containerInput == null) {
        resCB({
            ok: false,
            error: "system is not available",
        });
        return;
    }

    systemOutputBuf = "";
    systemOutputDelimiter = "AGENT COMMAND END " + crypto.randomUUID();
    curSystemOutputCB = (res) => {
        resCB(res);
        systemOutputDelimiter = "";
        systemOutputBuf = "";
    }
    containerInput(command + "\n");
    containerInput('echo "exit code: $?"\n');
    containerInput('# ' + systemOutputDelimiter + '\n');
}

// Tool definitions for the model

var list_workspaces_tool = {
    func: (resCB, arg, opts) => {
        opts.output("(list_workspaces)\n");
        vscodePostMessage("workspace/list", {}, resCB);
    },
    description: {
        type: "function",
        name: "list_workspaces",
        description: "Get a list of workspaces.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false
        },
        strict: true
    },
};

var read_file_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(read_file) : " + p + "\n");
        vscodePostMessage("fs/readFile", {
            workspace: arg.workspace,
            path: p,
        }, (res) => {
            res.data = res.data != null ? new TextDecoder().decode(res.data) : "";
            resCB(res);
        });
    },
    description: {
        type: "function",
        name: "read_file",
        description: "Read a file at the specified path in a workspace",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target file."
                },
            },
            required: ["workspace", "path"],
            additionalProperties: false
        },
        strict: true
    },
};

var read_directory_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(read_directory) : " + p + "\n");
        vscodePostMessage("fs/readDirectory", {
            workspace: arg.workspace,
            path: p,
        }, resCB);
    },
    description: {
        type: "function",
        name: "read_directory",
        description: "Get a list of files in a directory at the specified path in a workspace. The result is an array of a tuple (filename, filetype). The filetype is defined as follows: 0=unknown, 1=file, 2=directory, 3=symlink.",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target file."
                },
            },
            required: ["workspace", "path"],
            additionalProperties: false
        },
        strict: true
    },
};

var create_directory_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(create_directory) : " + p + "\n");
        vscodePostMessage("fs/createDirectory", {
            workspace: arg.workspace,
            path: p,
        }, resCB);
    },
    description: {
        type: "function",
        name: "create_directory",
        description: "Create a directory at the specified path in a workspace.",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target path."
                },
            },
            required: ["workspace", "path"],
            additionalProperties: false
        },
        strict: true
    },
};

var create_file_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(create_file) : " + p + "\n");
        vscodePostMessage("fs/createFile", {
            workspace: arg.workspace,
            path: p,
            contents: arg.contents ?? "",
        }, resCB);
    },
    description: {
        type: "function",
        name: "create_file",
        description: "Create an empty file at the specified path in a workspace. If create_file.contents is not needed, omit \"contents\" entirely. Do not set it to null.",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target path."
                },
                "contents": {
                    "type": "string",
                    "description": "Contents to write to the file (OPTIONAL)."
                },
            },
            required: ["workspace", "path"],
            additionalProperties: false
        },
        strict: true
    },
};

var patch_file_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        const d = arg.diff;
        opts.output("(patch_file) Path: " + p + "\n");
        opts.output("(patch_file) Diff:\n" + d + "\n");
        vscodePostMessage("fs/patchFile", {
            workspace: arg.workspace,
            path: p,
            diff: d,
        }, (res) => {
            if ((res != null) && (res.ok === true)) {
                opts.output("(patch_file) Applied\n");
            } else if ((res != null) && (res.ok === false)) {
                opts.output("(patch_file) Error: " + res.error + "\n");
            }
            resCB(res);
        });
    },
    description: {
        type: "function",
        name: "patch_file",
        description: "Apply a diff to a file at the specified path in a workspace.",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target path."
                },
                "diff": {
                    "type": "string",
                    "description": "Diff to apply to the file. It must be the unified diff format."
                },
            },
            required: ["workspace", "path", "diff"],
            additionalProperties: false
        },
        strict: true
    },
};

var copy_file_directory_tool = {
    func: (resCB, arg, opts) => {
        opts.output("(copy_file_directory) : " + arg.src_path + " => " + arg.dst_path + "\n");
        vscodePostMessage("fs/copyFileDirectory", {
            workspace: arg.workspace,
            src_path: arg.src_path,
            dst_path: arg.dst_path,
        }, resCB);
    },
    description: {
        type: "function",
        name: "copy_file_directory",
        description: "Copy a file or a directory from the source to the destination path in a workspace",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "src_path": {
                    "type": "string",
                    "description": "Target source path."
                },
                "dst_path": {
                    "type": "string",
                    "description": "Target destination path."
                },
            },
            required: ["workspace", "src_path", "dst_path"],
            additionalProperties: false
        },
        strict: true
    },
};

var rename_file_directory_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(rename_file_directory) : " + arg.src_path + " => " + arg.dst_path + "\n");
        vscodePostMessage("fs/renameFileDirectory", {
            workspace: arg.workspace,
            src_path: arg.src_path,
            dst_path: arg.dst_path,
        }, resCB);
    },
    description: {
        type: "function",
        name: "rename_file_directory",
        description: "Rename a file or a directory from the source to the destination path in a workspace",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "src_path": {
                    "type": "string",
                    "description": "Target source path."
                },
                "dst_path": {
                    "type": "string",
                    "description": "Target destination path."
                },
            },
            required: ["workspace", "src_path", "dst_path"],
            additionalProperties: false
        },
        strict: true
    },
};

var delete_file_directory_tool = {
    func: (resCB, arg, opts) => {
        const p = arg.path;
        opts.output("(delete_file_directory) : " + p + "\n");
        vscodePostMessage("fs/deleteFileDirectory", {
            workspace: arg.workspace,
            path: p,
        }, resCB);
    },
    description: {
        type: "function",
        name: "delete_file_directory",
        description: "Delete a file or a directory at the path in a workspace",
        parameters: {
            type: "object",
            properties: {
                "workspace": {
                    "type": "string",
                    "description": "Target workspace."
                },
                "path": {
                    "type": "string",
                    "description": "Target path."
                },
            },
            required: ["workspace", "path"],
            additionalProperties: false
        },
        strict: true
    },
};

var system_tool = {
    func: (resCB, arg, opts) => {
        opts.output("(system tool) Running: " + arg.command + "\n");
        systemCommand(arg.command, (res) => {
            if (typeof res === "string") {
                opts.output("(system tool) Output:\n" + res + "\n");
            } else if ((res != null) && (res.ok === false) && (res.error != null)) {
                opts.output("(system tool) Error: " + res.error + "\n");
            }
            resCB(res);
        });
    },
    description: {
        type: "function",
        name: "system",
        description: `Runs a shell command on Linux and returns the output.
This terminal is shared globally among workspaces so you DO NOT need to specify a workspace name to use it.
This API synchronously invoke the command and wait for the output.
DO NOT run a command that waits for an input or loops forever.
If you need to run the command in background without blocking, you can use shell's "&" operator.
If the command will potentially hang, use the command's timeout feature or shell's timeout command.
`,
        parameters: {
            type: "object",
            properties: {
                "command": {
                    "type": "string",
                    "description": "Shell command to run."
                },
            },
            required: ["command"],
            additionalProperties: false
        },
        strict: true
    },
};

const functionSchema = `{
  "type": "object",
  "properties": {
    "thinking": {
      "type": "string"
    },
    "response": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": ["call", "message"]
        },
        "data": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "name": { "type": "string" },
                "arguments": { "type": "object" }
              },
              "required": ["name", "arguments"],
              "additionalProperties": false
            },
            {
              "type": "string"
            }
          ]
        }
      },
      "required": ["type", "data"],
      "additionalProperties": false
    }
  },
  "required": ["thinking", "response"],
  "additionalProperties": false
}`;

let function_tools = [list_workspaces_tool, read_file_tool, read_directory_tool, create_file_tool, create_directory_tool, patch_file_tool, rename_file_directory_tool, copy_file_directory_tool, delete_file_directory_tool];
if (enableTerminal) {
    function_tools.push(system_tool)
}

function createToolsSystemPrompt() {
    var prompt = `
You MAY call functions following the user's prompt.

# RESPONSE FORMAT RULES

Your output MUST match the JSON schema defined as follows.

`;

    prompt += functionSchema;

    prompt += `

There are two possible responses:

1. Send a message to the user

Set:
"type": "message"

Example:

"response": {
  "type": "message",
  "data": "Hello!"
}

2. Call a function

Set:
"type": "call"

Example:

"response": {
  "type": "call",
  "data": {
    "name": "read_file",
    "arguments": {
      "workspace": "work",
      "path": "foo.txt"
    }
  }
}

Rules:

- Only ONE function call per message.
- Do NOT embed function calls inside arguments.
- After a function call, the function result will appear in the next input.
- Do NOT invent the function result.

# CRITICAL ENVIRONMENT RULES

You are in a VSCode IDE environment containing multiple workspaces.

There is NO default workspace.

Workspace names are exact strings.
They must never be guessed.

Before any workspace file operation, you MUST know the exact workspace name.
If you do not know it yet, you MUST call:

list_workspaces

Never invent or guess workspace names.

# WORKSPACE FILE PATH RULES

Workspace file tools use RELATIVE paths.

Correct examples:
  "foo.txt"
  "src/main.c"
  "folder/file.txt"

Incorrect examples:
  "/foo.txt"
  "${workspaceMountpoint}/work/foo.txt"
  "./foo.txt"

When calling file tools, NEVER use absolute paths.

# SYSTEM COMMAND RULES

The system() function runs a shell command on Linux.

Important:

All workspaces are mounted READ-ONLY at:

${workspaceMountpoint}/<workspace-name>/

Examples:
  ${workspaceMountpoint}/work/foo.txt
  ${workspaceMountpoint}/project/src/main.c

The shell current directory is NOT guaranteed to be any workspace.

Therefore:

- Never rely on the shell current directory.
- Prefer absolute paths in shell commands.

# WRITE RESTRICTION

The directory:

${workspaceMountpoint}/<workspace-name>/

is READ-ONLY.

You MUST NEVER create, modify, delete, rename, or compile files inside ${workspaceMountpoint}.

Shell commands that write files MUST use writable location such as /tmp/.

# WORKSPACE PATH CONVERSION

If the user refers to:

foo.txt in workspace "work"

Then:

File tool path:
  workspace="work"
  path="foo.txt"

Shell path:
  ${workspaceMountpoint}/work/foo.txt

# RECOMMENDED BUILD PROCEDURE

If a command needs to modify files or generate build artifacts:

1. Copy the workspace or files to /tmp
2. Work inside /tmp

# FILE MANIPULATION

When reading or editing workspace files, prefer these tools:

read_file
read_directory
create_file
create_directory
patch_file
rename_file_directory
copy_file_directory
delete_file_directory

Do NOT use system() to edit workspace files.

Use system() mainly for:

- compiling code
- running programs
- inspecting environment
- building projects inside /tmp

# BEFORE CALLING the system function

Always verify:

1. Workspace files use:
   ${workspaceMountpoint}/<workspace-name>/<relative-path>

2. The command does NOT write into ${workspaceMountpoint}

3. Writable outputs go into /tmp

4. The command does not rely on the current directory

After calling a function, its result will be provided as the next input.

# AVAILABLE FUNCTIONS

[`;

    for (const f of function_tools) {
        prompt += JSON.stringify(f.description);
        prompt += ',';
    }
    
    prompt += `]`
    return prompt;
}

var callTools = {
    handle: (data, resCB, opts) => {
        var output;
        try {
            output = JSON.parse(data.replace(/<think>[\s\S]*?<\/think>/g, ""));
        } catch (e) {
            return "";
        }
        var ok = false;
        if ((output.response.type == "call") && (output.response.data.name != "")) {
            var targetname = output.response.data.name;
            for (const f of function_tools) {
                if (f.description.name == targetname) {
                    f.func(resCB, output.response.data.arguments, opts);
                    ok = true;
                }
            }
        } else if ((output.response.type == "message") && (output.response.data != "")) {
            opts.output(output.response.data + "\n");
        }
        return ok;
    }
}

// LLMlet panel

const llmletModJsBlobUri = await makeBlobUrl(vendorFiles['llmlet-mod.js']);

const enableWebGPU = await getExtensionConfig('enableWebGPU');
let peerEnabled = await getExtensionConfig('peer.enabled');
const remoteEngineURL = await getExtensionConfig('remoteAPI.url');
const remoteEngineModel = await getExtensionConfig('remoteAPI.model');
if ((remoteEngineURL != "") && (remoteEngineModel != "")) {
    console.log("Using remote engine. Disabling local peer.");
    peerEnabled = false;
}

var node;
var peer;
let peersList = [];
setInterval(async () => {
    const peersListCfg = await getExtensionConfig('peer.peers');
    peersList = peersListCfg.split(/[\s,]+/).filter((w) => w != "");
}, 1000);
if (peerEnabled) {
    const peerserverAddress = await getExtensionConfig('peer.peerServer');
    var peerOptions = {
        debug: 2,
    };
    if (peerserverAddress != '') {
        const parts = peerserverAddress.split(":");
        peerOptions.host = parts[0];
        peerOptions.port = parts[1] || "";
    }
    var curServer;
    peer = newPeer({
        peerOptions: peerOptions,
        printLog: (l) => logToVSCodeOutput('[peer] ' + l),
        onOpen: async (id) => {
            if (curServer != null) {
                curServer.exit();
            }
            logToVSCodeOutput('[peer] Peer ID: ' + id);
            node = id;
            const params = new URLSearchParams(window.location.search);
            if (params.get('noserver') != 'true') {
                curServer = startServer(peer, await import(llmletModJsBlobUri), {
                    log: (l) => logToVSCodeOutput('[server] ' + l),
                    getTargetNodes: () => peersList,
                    mainScriptUrlOrBlob: llmletModJsBlobUri,
                    locateFile: (path) => {
                        return vendorFiles[path];
                    },
                    disableWebGPU: !enableWebGPU,
                });
            }
        }
    });
}

const cancelButton = document.getElementById('cancelButton');
let decodingCancel = false;
cancelButton.onclick = () => {
    decodingCancel = true;
    if (curSystemOutputCB != null) {
        containerInput("\x03"); // try cancelling the current command
        curSystemOutputCB({
            ok: false,
            error: "cancelled by user",
        });
        curSystemOutputCB = null;
    }
}

const llmletClientQuiet = await getExtensionConfig('quiet');
const llmletClientModel = await getExtensionConfig('model');
const llmletClientContextSize = await getExtensionConfig('contextSize');
const llmletClientUbatchSize = await getExtensionConfig('ubatchSize');
var runningClient = null;
var clientOptions = {
    output: (l) => printText(output, l),
    log: (l) => logToVSCodeOutput('[client] ' + l),
    getTargetNodes: () => peersList,
    getModelURL: () => llmletClientModel,
    locateFile: (path) => vendorFiles[path],
    getSystemPrompt: createToolsSystemPrompt,
    jsonSchema: functionSchema,
    outputHandler: callTools,
    isDecodingCancel: () => {
        const res = decodingCancel;
        decodingCancel = false;
        return res;
    },
    quiet: llmletClientQuiet,
    args: ['-c', `${llmletClientContextSize}`, '-u', `${llmletClientUbatchSize}`],
    disableWebGPU: !enableWebGPU,
    mainScriptUrlOrBlob: llmletModJsBlobUri,
};

async function newLocalClient() {
    const module = await import(llmletModJsBlobUri);
    return startClient(peer, module, clientOptions);
}

async function newRemoteClient(endpoint, modelName) {
    var c = {
        context: [],
    };

    async function getResponse() {
        const contextStr = JSON.stringify(c.context);
        const data = `{
  "model": "${modelName}",
  "messages": ${contextStr},
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "message",
      "strict": true,
      "schema": ${functionSchema}
    }
  }
}`
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: data
        });
        if (!response.ok) {
            throw new Error(`failed chat completions api request: ${response.status}`);
        }
        const text = await response.text();
        const output = JSON.parse(text);
        return output.choices[0].message.content;
    }

    var pending_prompt_reader = [];
    function waitForInput() {
        pending_prompt_reader.push((res) => {
            printText(output, res + '\n');
            handleInput(res);
        });
    }

    var inputBuf = "";
    async function handleInput(msg) {
        c.context.push({"role": "user", "content": msg});
        var resp = await getResponse();
        if (!llmletClientQuiet) printText(output, resp + '\n');
        c.context.push({"role": "assistant", "content": resp});
        var ok = callTools.handle(
            resp,
            (res) => {
                if (typeof res === "string") {
                    handleInput(res);
                } else {
                    handleInput(JSON.stringify(res));
                }
            },
            {
                output: (l) => printText(output, l),
            },
        );
        if (ok) {
            return;
        }
        printText(output, "(you) ");
        if (inputBuf != "") {
            const res = inputBuf;
            inputBuf = "";
            printText(output, res + '\n');
            c.input(res);
        } else {
            waitForInput();
        }
    }

    c.input = (msg) => {
        if (pending_prompt_reader.length == 0) {
            inputBuf = msg;
        } else {
            var cb = pending_prompt_reader.shift();
            cb(msg);
        }
    }
    c.isRunning = () => true;
    c.context.push({"role": "system", "content": createToolsSystemPrompt()});
    printText(output, "(you) ");
    waitForInput();

    return c;
}

async function newClient() {
    if ((remoteEngineURL != "") && (remoteEngineModel != "")) {
        return newRemoteClient(remoteEngineURL, remoteEngineModel);
    }
    return newLocalClient();
}

async function handleSystemCommand(msg) {
    var cmds = msg.split(/[\s]+/).filter((w) => w != "");
    if (cmds.length == 0) {
        return false;
    }
    console.debug("checking " + cmds[0]);
    switch (cmds[0]) {
    case "/help":
        printText(output, "(command) " + msg + "\n");
        let helpText = `
/-prefixed string is interpreted as a command and other strings are passed to the model.
Available commands are the following:

  /help          : Show this help message
  /restart       : Restart the chat session
  /exit          : Exit the current chat session
  /open-terminal : Open terminal if closed
`;
        printText(output, helpText);
        return true;
    case "/restart":
        printText(output, "(command) " + msg + "\n");
        if (runningClient && runningClient.isRunning()) {
            runningClient.exit();
        }
        decodingCancel = false;
        runningClient = newClient();
        return true;
    case "/exit":
        printText(output, "(command) " + msg + "\n");
        if (runningClient && runningClient.isRunning()) {
            runningClient.exit();
        }
        runningClient = null;
        return true;
    case "/open-terminal":
        printText(output, "(command) " + msg + "\n");
        if (enableTerminal) {
            openTerminal((res) => {
                if (ok) {
                    printText(output, "Terminal panel opened. Enter something there.\n");
                } else {
                    printText(output, "Terminal panel failed to open.\n");
                }
            });
        } else {
            printText(output, "Target container is not configured\n");
        }
        return true;
    default:
        return false;
    }
}

const doPromptButton = document.getElementById('doPromptButton');
const promptMessage = document.getElementById('promptMessage');
async function enterPrompt() {
    var msg = promptMessage.value;
    promptMessage.value = "";

    if (msg == "") {
        return;
    }

    if (await handleSystemCommand(msg)) {
        return;
    }

    if (!runningClient || !runningClient.isRunning()) {
        decodingCancel = false;
        runningClient = await newClient();
    }

    runningClient.input(msg);
    promptMessage.style.height = 'auto';
    promptMessage.style.height = promptMessage.scrollHeight + 'px';
}

promptMessage.addEventListener("keypress", function(event) {
    if ((event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        enterPrompt();
    }
});
promptMessage.addEventListener("input", function(event) {
    promptMessage.style.height = 'auto';
    promptMessage.style.height = promptMessage.scrollHeight + 'px';
});

doPromptButton.onclick = enterPrompt;
