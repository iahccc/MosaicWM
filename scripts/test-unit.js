#!/usr/bin/env node
import {readdirSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const directory = new URL('./', import.meta.url);
for (const name of readdirSync(directory).sort()) {
    if (!/^test-.*\.js$/.test(name) || name === 'test-unit.js') continue;
    const path = new URL(name, directory);
    if (readFileSync(path, 'utf8').includes('export async function run')) continue;
    const result = spawnSync(process.execPath, [path.pathname], {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status ?? 1);
}
