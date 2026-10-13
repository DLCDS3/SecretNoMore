import fs from 'node:fs';
import { validateAutomation, validateProduct } from './flow.mjs';
try {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  validateProduct(read(process.argv[2]));
  validateAutomation(read(process.argv[3]));
  console.log('Automation configuration valid. Live selectors are not verified by this check.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
