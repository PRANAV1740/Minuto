import { testStoreContract } from './contract.ts';
import { createMemoryStore } from './memory.ts';

testStoreContract('memory', async () => createMemoryStore());
