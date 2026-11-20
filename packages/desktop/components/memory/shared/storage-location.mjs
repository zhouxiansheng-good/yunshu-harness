import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

const pointer = () => dshHomePath('plugins', 'yunshu-memory', 'storage-location.json');
const defaults = () => ({ memory: dshHomePath('plugins', 'yunshu-memory', 'memory.sqlite'), identity: dshHomePath('plugins', 'yunshu-persona', 'identity.sqlite'), media: dshHomePath('plugins', 'yunshu-memory', 'media') });
const at = root => ({ memory: join(root, 'memory.sqlite'), identity: join(root, 'identity.sqlite'), media: join(root, 'media') });
const read = () => {
  const file = pointer();
  if (!existsSync(file)) return { schema: 1, root: null, pending: null };
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.schema !== 1 || (value.root !== null && typeof value.root !== 'string') || (value.pending !== null && typeof value.pending !== 'string')) throw new Error('存档区设置无效');
  return value;
};
const save = value => {
  const file = pointer(), tmp = file + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ schema: 1, ...value }, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
  renameSync(tmp, file);
};
export function validateStorageRoot(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || !isAbsolute(input)) throw new Error('请输入绝对路径');
  const root = resolve(input.trim());
  if (root === parse(root).root) throw new Error('不能将磁盘根目录用作存档区');
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('请选择普通文件夹');
  return realpathSync(root);
}
function existingStorageRoot(input) {
  if (!existsSync(input)) throw new Error('已选存档区不存在：' + input);
  return validateStorageRoot(input);
}
function checkpoint(file) {
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file);
  try { const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (result?.busy) throw new Error('数据库正在使用，请退出其他 DeepSeek 窗口后重试'); }
  finally { db.close(); }
}
function migrate(source, destination) {
  const root = dirname(destination.memory);
  const present = [existsSync(destination.memory), existsSync(destination.identity)];
  if (present.every(Boolean)) return;
  if (present.some(Boolean)) throw new Error('目标存档区缺少记忆或身份数据库');
  if (readdirSync(root).length) throw new Error('目标文件夹不为空，且不是云舒存档区');
  if (root.startsWith(source.media + '\\') || root.startsWith(source.media + '/')) throw new Error('新存档区不能放在旧媒体目录中');
  const stage = root + '.yunshu-copying';
  if (existsSync(stage)) throw new Error('迁移临时目录已存在，请检查：' + stage);
  mkdirSync(stage);
  try {
    checkpoint(source.memory); checkpoint(source.identity);
    if (existsSync(source.memory)) copyFileSync(source.memory, join(stage, 'memory.sqlite'));
    if (existsSync(source.identity)) copyFileSync(source.identity, join(stage, 'identity.sqlite'));
    if (existsSync(source.media)) cpSync(source.media, join(stage, 'media'), { recursive: true, errorOnExist: true, force: false });
    rmdirSync(root); renameSync(stage, root);
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function storagePaths() {
  const state = read(); let error = null;
  if (state.pending) try {
    const next = validateStorageRoot(state.pending), previous = state.root ? at(existingStorageRoot(state.root)) : defaults();
    migrate(previous, at(next)); save({ root: next, pending: null }); state.root = next; state.pending = null;
  } catch (cause) { error = cause.message; }
  if (state.root) try { return { ...at(existingStorageRoot(state.root)), root: state.root, selected: true, error }; }
  catch (cause) { error = cause.message; }
  return { ...defaults(), root: dirname(defaults().memory), selected: false, error };
}
export function storageStatus() {
  const state = read(); let active, error = null;
  try { active = state.root ? existingStorageRoot(state.root) : dirname(defaults().memory); }
  catch (cause) { active = dirname(defaults().memory); error = cause.message; }
  return { active, paths: active === state.root ? at(active) : defaults(), pending: state.pending, selected: active === state.root, restartRequired: !!state.pending, error };
}
export function selectStorageRoot(input) {
  const root = validateStorageRoot(input), state = read();
  if (root === (state.root ?? dirname(defaults().memory))) return storageStatus();
  const files = readdirSync(root);
  if (files.length && !existsSync(join(root, 'memory.sqlite'))) throw new Error('目标文件夹不为空，且不是云舒存档区');
  if (existsSync(join(root, 'memory.sqlite')) !== existsSync(join(root, 'identity.sqlite'))) throw new Error('目标存档区缺少记忆或身份数据库');
  save({ root: state.root, pending: root }); return storageStatus();
}
