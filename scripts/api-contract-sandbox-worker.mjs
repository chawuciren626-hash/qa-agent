/** Parse one archived API contract inside the confined, network-free WSL job. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectApiContract } from './api-contract.mjs';

const [requestPath, contractPath, outputPath] = process.argv.slice(2).map(value => resolve(value));
if (!requestPath || !contractPath || !outputPath) throw new Error('Expected request, contract and output paths');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
if (request.version !== 1 || !Array.isArray(request.operations) || request.operations.some(value => typeof value !== 'string') ||
    (request.source_path !== null && typeof request.source_path !== 'string')) throw new Error('Invalid API contract parse request');
const bytes = readFileSync(contractPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const result = inspectApiContract(bytes, { operations: request.operations, source_path: request.source_path });
writeFileSync(outputPath, JSON.stringify({ version: 1, input_sha256: sha256, result }), { flag: 'wx' });
