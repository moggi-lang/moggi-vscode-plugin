import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

/**
 * Moggi VS Code extension — a thin client around the real language server,
 * which is the Moggi compiler itself, reached through the launcher an installed
 * distribution ships: `bin/moggi lsp` (stdio), or `bin/moggi.exe` on Windows.
 *
 * The compiler is NOT bundled: the extension locates a launcher, set with
 * `moggi.path` or found in a workspace folder or on `PATH`, and speaks to it.
 * The launcher brings the compiler archive and its own PHP runtime, so no PHP
 * needs to be installed on the machine running VS Code.
 */

const LAUNCHER_NAME = process.platform === 'win32' ? 'moggi.exe' : 'moggi';
const RELEASES_URL = 'https://github.com/moggi-lang/moggi/releases';

interface MoggiContext {
  /** Absolute path to the launcher, or a bare name resolved through `PATH`. */
  launcher: string;
}

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;
let status: vscode.StatusBarItem | undefined;

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return workspaceFolders()[0];
}

function statOf(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

/** A launcher has to be there and be runnable; Windows has no mode bits. */
function isLauncher(file: string): boolean {
  const stat = statOf(file);
  if (!stat?.isFile()) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A launcher, its `bin/` directory, or an installation root all name one. */
function launcherAt(target: string): string | undefined {
  for (const candidate of [target, path.join(target, 'bin', LAUNCHER_NAME), path.join(target, LAUNCHER_NAME)]) {
    if (isLauncher(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function launcherOnPath(): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '');
  for (const entry of entries) {
    const candidate = path.join(entry, LAUNCHER_NAME);
    if (isLauncher(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function whyNoLauncher(base: string): string {
  if (/\.phar$/i.test(base)) {
    return `${base} is the compiler archive, not the launcher — point "moggi.path" at bin/${LAUNCHER_NAME} beside it`;
  }
  const stat = statOf(base);
  if (stat?.isDirectory()) {
    return `no ${LAUNCHER_NAME} launcher in ${base}`;
  }
  if (stat) {
    return `${base} is not executable — chmod +x it, or point "moggi.path" at bin/${LAUNCHER_NAME}`;
  }
  return `nothing at ${base}`;
}

/**
 * The launcher to talk to: `moggi.path` when set (the launcher itself, its
 * `bin/` directory, or the distribution root), else one in a workspace folder,
 * else one on `PATH`.
 */
function resolveLauncher(): MoggiContext | { error: string } {
  const configured = (vscode.workspace.getConfiguration('moggi').get<string>('path') ?? '').trim();
  if (configured !== '') {
    const base = path.isAbsolute(configured)
      ? configured
      : path.join(firstWorkspaceFolder()?.uri.fsPath ?? '', configured);
    const found = launcherAt(base);
    return found ? { launcher: found } : { error: whyNoLauncher(base) };
  }

  for (const folder of workspaceFolders()) {
    const found = launcherAt(folder.uri.fsPath);
    if (found) {
      return { launcher: found };
    }
  }

  const onPath = launcherOnPath();
  if (onPath) {
    return { launcher: onPath };
  }

  return {
    error: `no Moggi launcher found — install a distribution from ${RELEASES_URL} and set "moggi.path" to its bin/${LAUNCHER_NAME}`,
  };
}

function libArgs(): string[] {
  const libPaths = vscode.workspace.getConfiguration('moggi').get<string[]>('libPaths') ?? [];
  return libPaths.flatMap((p) => ['--lib', p]);
}

/** The launcher finds the compiler and its runtime by itself, so the server runs in the workspace. */
function serverCwd(moggi: MoggiContext): string {
  const folder = firstWorkspaceFolder();
  if (folder) {
    return folder.uri.fsPath;
  }
  return path.isAbsolute(moggi.launcher) ? path.dirname(moggi.launcher) : process.cwd();
}

function setStatus(state: 'starting' | 'checking' | 'ready' | 'error' | 'restarting', message?: string): void {
  if (!status) {
    return;
  }
  switch (state) {
    case 'starting':
      status.text = 'Moggi: starting…';
      break;
    case 'checking':
      status.text = 'Moggi: checking…';
      break;
    case 'ready':
      status.text = 'Moggi';
      break;
    case 'error':
      status.text = 'Moggi: error';
      break;
    case 'restarting':
      status.text = 'Moggi: restarting…';
      break;
  }
  if (message) {
    status.tooltip = `Moggi: ${message}`;
  }
}

function startClient(moggi: MoggiContext): void {
  const serverArgs = ['lsp', ...libArgs()];
  const cwd = serverCwd(moggi);
  output?.appendLine(`Starting: ${moggi.launcher} ${serverArgs.join(' ')} (cwd: ${cwd})`);

  const options = { cwd };
  const serverOptions: ServerOptions = {
    run: {
      command: moggi.launcher,
      args: serverArgs,
      transport: TransportKind.stdio,
      options,
    },
    debug: {
      command: moggi.launcher,
      args: serverArgs,
      transport: TransportKind.stdio,
      options,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'moggi' },
      { scheme: 'untitled', language: 'moggi' },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.mog'),
      configurationSection: 'moggi',
    },
    outputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Error,
  };

  client = new LanguageClient('moggi', 'Moggi Language Server', serverOptions, clientOptions);

  client.onNotification('moggi/status', (params: { state?: string; message?: string }) => {
    if (params?.state === 'checking') {
      setStatus('checking');
    } else if (params?.state === 'ready') {
      setStatus('ready');
    } else if (params?.message) {
      setStatus('ready', params.message);
    }
  });

  void client.start().then(
    () => {
      setStatus('ready');
      output?.appendLine('Moggi language server started.');
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('error', message);
      output?.appendLine(`Failed to start Moggi language server: ${message}`);
      void vscode.window.showErrorMessage(
        `Moggi language server failed to start: ${message}. See "Moggi: Show Output".`,
      );
    },
  );
}

// --------------------------------------------------------------------- tasks

function registerTaskProvider(moggi: MoggiContext): vscode.Disposable {
  return vscode.tasks.registerTaskProvider('moggi', {
    provideTasks: () => {
      const backend = vscode.workspace.getConfiguration('moggi').get<string>('backend') || 'php';
      const tasks: vscode.Task[] = [];
      for (const folder of workspaceFolders()) {
        const compile = new vscode.Task(
          { type: 'moggi', task: 'compile' },
          folder,
          `compile ${folder.name}`,
          'moggi',
          new vscode.ProcessExecution(
            moggi.launcher,
            ['compile', folder.uri.fsPath, '-o', path.join(folder.uri.fsPath, 'out'), '--backend', backend],
            { cwd: folder.uri.fsPath },
          ),
          ['$moggi'],
        );
        tasks.push(compile);
      }
      return tasks;
    },
    resolveTask: (task) => task,
  });
}

// --------------------------------------------------------------- run command

async function runCurrentFile(moggi: MoggiContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'moggi') {
    void vscode.window.showErrorMessage('Moggi: open a .mog file to run it.');
    return;
  }
  const file = editor.document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const cwd = folder?.uri.fsPath ?? path.dirname(moggi.launcher);
  const backend = vscode.workspace.getConfiguration('moggi').get<string>('backend') || 'php';

  const term = vscode.window.createTerminal({ name: 'Moggi Run', cwd });
  term.show(true);
  term.sendText(`${quote(moggi.launcher)} run ${quote(file)} --backend ${backend}`);
}

function quote(p: string): string {
  return /\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

// -------------------------------------------------------------- test explorer

function registerTestExplorer(context: vscode.ExtensionContext, moggi: MoggiContext): void {
  const ctrl = vscode.tests.createTestController('moggiRuntime', 'Moggi Runtime Tests');
  context.subscriptions.push(ctrl);

  const resolveTestRoot = (): string | undefined => {
    const configured = vscode.workspace.getConfiguration('moggi').get<string>('testRoot') ?? '';
    const folder = firstWorkspaceFolder();
    if (configured.trim() !== '') {
      if (path.isAbsolute(configured)) {
        return configured;
      }
      return folder ? path.join(folder.uri.fsPath, configured) : undefined;
    }
    return folder ? path.join(folder.uri.fsPath, 'tests', 'backend', 'runtime') : undefined;
  };

  const refresh = async (): Promise<void> => {
    ctrl.items.replace([]);
    const runtimeDir = resolveTestRoot();
    if (runtimeDir === undefined || !fs.existsSync(runtimeDir)) {
      // Nothing configured (or the directory is missing): stay empty, don't fail.
      return;
    }
    for (const name of fs.readdirSync(runtimeDir).sort()) {
      if (!name.endsWith('.mog')) {
        continue;
      }
      const item = ctrl.createTestItem(`runtime:${name}`, name, vscode.Uri.file(path.join(runtimeDir, name)));
      ctrl.items.add(item);
    }
  };

  ctrl.refreshHandler = () => refresh();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('moggi.testRoot')) {
      void refresh();
    }
  }));
  void refresh();

  // A case passes when `moggi run` accepts it: the compiler owns the fixtures, so
  // it is also the thing that decides what running one means.
  const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> => {
    const run = ctrl.createTestRun(request);
    const queue: vscode.TestItem[] = [];
    if (request.include) {
      request.include.forEach((t) => queue.push(t));
    } else {
      ctrl.items.forEach((t) => queue.push(t));
    }
    for (const test of queue) {
      if (token.isCancellationRequested) {
        break;
      }
      run.started(test);
      const file = test.uri?.fsPath;
      if (!file) {
        run.skipped(test);
        continue;
      }
      const start = Date.now();
      try {
        const result = await new Promise<{ code: number; out: string }>((resolve) => {
          const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
          const child = cp.spawn(moggi.launcher, ['run', file], {
            cwd: folder?.uri.fsPath ?? path.dirname(moggi.launcher),
          });
          let out = '';
          child.stdout.on('data', (d: Buffer) => {
            out += d.toString();
            run.appendOutput(d.toString().replace(/\n/g, '\r\n'));
          });
          child.stderr.on('data', (d: Buffer) => {
            out += d.toString();
            run.appendOutput(d.toString().replace(/\n/g, '\r\n'));
          });
          child.on('close', (code) => resolve({ code: code ?? 1, out }));
        });
        if (result.code === 0) {
          run.passed(test, Date.now() - start);
        } else {
          run.failed(test, new vscode.TestMessage(result.out.trim() || `exit code ${result.code}`), Date.now() - start);
        }
      } catch (e) {
        run.failed(test, new vscode.TestMessage(e instanceof Error ? e.message : String(e)));
      }
    }
    run.end();
  };

  ctrl.createRunProfile('Run', vscode.TestRunProfileKind.Run, runHandler, true);
}

// ---------------------------------------------------------------- activation

function reportMissingLauncher(reason: string): void {
  setStatus('error', reason);
  output?.appendLine(reason);
  void vscode.window
    .showErrorMessage(`Moggi: ${reason}.`, 'Open Settings', 'Download')
    .then((choice) => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'moggi.path');
      } else if (choice === 'Download') {
        void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
      }
    });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Moggi');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = 'Moggi: starting…';
  status.command = 'moggi.showOutput';
  status.show();
  context.subscriptions.push(output, status);

  const resolved = resolveLauncher();
  if ('error' in resolved) {
    reportMissingLauncher(resolved.error);
    return;
  }
  const moggi: MoggiContext = resolved;

  output.appendLine(`Using launcher: ${moggi.launcher}`);
  startClient(moggi);

  context.subscriptions.push(
    registerTaskProvider(moggi),
    vscode.commands.registerCommand('moggi.runFile', () => void runCurrentFile(moggi)),
    vscode.commands.registerCommand('moggi.restartServer', async () => {
      if (!client) {
        return;
      }
      setStatus('restarting');
      output?.appendLine('Restarting Moggi language server…');
      await client.stop();
      startClient(moggi);
    }),
    vscode.commands.registerCommand('moggi.showOutput', () => output?.show(true)),
    { dispose: () => void client?.stop() },
  );

  registerTestExplorer(context, moggi);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
