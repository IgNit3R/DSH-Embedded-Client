'use strict';

/**
 * 本地服务进程管理器。
 *
 * 支持：
 *   - 直接 exe / 无扩展名可执行名（走 PATH 解析）
 *   - .bat / .cmd（Node 在 Windows 上要求必须经 shell 启动）
 *   - .ps1（powershell -File）
 *   - .py（python）、.js（node）
 *
 * 特性：
 *   - stdout/stderr 按 UTF-8 行缓冲转发
 *   - 停止时用 taskkill /T /F 结束整个进程树（Windows），避免孤儿子进程
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

class ServiceManager {
  /**
   * @param {{ baseDir?: string, onEvent?: (event: object) => void }} [options]
   */
  constructor({ baseDir = process.cwd(), onEvent = () => {} } = {}) {
    this.baseDir = baseDir;
    this.emitEvent = onEvent;
    /** @type {Map<string, object>} id -> 运行记录 */
    this.running = new Map();
  }

  /**
   * 启动一个服务。spec: { id, command, args?, cwd?, env? }
   * args 可以是数组，也可以是空格分隔的字符串（支持双引号包裹）。
   */
  start(spec) {
    const id = typeof spec.id === 'string' ? spec.id.trim() : '';
    const command = typeof spec.command === 'string' ? spec.command.trim() : '';
    if (!id) throw new Error('缺少服务名称 id');
    if (!command) throw new Error('缺少启动命令 command');
    if (this.running.has(id)) throw new Error(`服务「${id}」已在运行`);

    const args = Array.isArray(spec.args)
      ? spec.args.map(String)
      : typeof spec.args === 'string' && spec.args.trim()
        ? splitArgs(spec.args)
        : [];

    const resolved = this.resolveCommand(command);
    const { file, spawnArgs, useShell } = buildSpawn(resolved, args);

    const cwd = spec.cwd
      ? path.resolve(this.baseDir, String(spec.cwd))
      : path.isAbsolute(resolved)
        ? path.dirname(resolved)
        : this.baseDir;

    const env = { ...process.env, ...(spec.env || {}) };

    let child;
    try {
      child = spawn(file, spawnArgs, { cwd, env, windowsHide: true, shell: useShell });
    } catch (err) {
      throw new Error(`启动失败: ${err instanceof Error ? err.message : err}`);
    }

    const record = {
      id,
      pid: child.pid ?? null,
      command: resolved,
      args,
      cwd,
      startedAt: Date.now(),
      child,
      stopping: false,
      buffers: { stdout: '', stderr: '' },
    };
    this.running.set(id, record);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    this.wireStream(child.stdout, record, 'stdout');
    this.wireStream(child.stderr, record, 'stderr');

    child.on('error', (err) => {
      this.emitEvent({ id, type: 'error', message: err.message });
      // spawn 失败（如文件不存在）不会触发 close，需要手动清理
      if (this.running.get(id) === record) this.running.delete(id);
    });

    child.on('close', (code, signal) => {
      this.flush(record, 'stdout');
      this.flush(record, 'stderr');
      if (this.running.get(id) === record) this.running.delete(id);
      this.emitEvent({ id, type: 'exit', code, signal: signal ?? null });
    });

    this.emitEvent({
      id,
      type: 'started',
      pid: record.pid,
      command: resolved,
      args,
      cwd,
    });

    return { id, pid: record.pid, command: resolved, args, cwd };
  }

  /** 停止服务：taskkill /T 连带子进程一起杀；返回是否找到该服务。 */
  stop(id) {
    const record = this.running.get(id);
    if (!record) return false;
    record.stopping = true; // S2: 同步置位，消除「将死进程仍被 isRunning 判真」的竞态窗口
    const { pid, child } = record;
    if (pid) {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
      });
      killer.on('error', () => child.kill());
    } else {
      child.kill();
    }
    return true;
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  /** S2: 服务是否正在停止（stop 已调用但进程树尚未完全退出）。 */
  isStopping(id) {
    const record = this.running.get(id);
    return Boolean(record && record.stopping);
  }

  list() {
    return [...this.running.values()].map(({ id, pid, command, args, cwd, startedAt }) => ({
      id,
      pid,
      command,
      args,
      cwd,
      startedAt,
      uptimeMs: Date.now() - startedAt,
    }));
  }

  resolveCommand(command) {
    if (path.isAbsolute(command)) return path.normalize(command);
    if (/[\\/]/.test(command)) return path.join(this.baseDir, command);
    // 无路径分隔符：交给 PATH 解析（如 python、myserver.exe）
    return command;
  }

  wireStream(stream, record, channelName) {
    if (!stream) return;
    const newline = /\r?\n/;
    stream.on('data', (chunk) => {
      record.buffers[channelName] += chunk;
      let match;
      while ((match = newline.exec(record.buffers[channelName])) !== null) {
        const line = record.buffers[channelName].slice(0, match.index);
        record.buffers[channelName] = record.buffers[channelName].slice(match.index + match[0].length);
        if (line) this.emitEvent({ id: record.id, type: channelName, data: line });
      }
    });
  }

  flush(record, channelName) {
    const rest = record.buffers[channelName];
    if (rest) this.emitEvent({ id: record.id, type: channelName, data: rest });
    record.buffers[channelName] = '';
  }
}

/** 根据扩展名决定实际启动方式。 */
function buildSpawn(resolvedCommand, args) {
  const ext = path.extname(resolvedCommand).toLowerCase();
  switch (ext) {
    case '.bat':
    case '.cmd':
      // Windows 上 Node 要求 bat/cmd 必须经 shell 启动
      return { file: resolvedCommand, spawnArgs: args, useShell: true };
    case '.ps1':
      return {
        file: 'powershell.exe',
        spawnArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedCommand, ...args],
        useShell: false,
      };
    case '.py':
      return { file: 'python', spawnArgs: [resolvedCommand, ...args], useShell: false };
    case '.js':
      return { file: 'node', spawnArgs: [resolvedCommand, ...args], useShell: false };
    default:
      return { file: resolvedCommand, spawnArgs: args, useShell: false };
  }
}

/** 简易参数切分：按空格拆分，支持双引号包裹含空格的参数。 */
function splitArgs(input) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

module.exports = ServiceManager;
