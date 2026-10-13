import { createServer } from 'node:http';
import { createHandler } from './app.ts';
import { createTorBox } from './torbox.ts';

const apiKey = process.env.TORBOX_API_KEY?.trim();
const port = Number(process.env.SERVER_PORT) || 8787;

createServer(createHandler(apiKey ? createTorBox(apiKey) : null)).listen(port, '127.0.0.1', () => {
  console.log(`server listening on http://127.0.0.1:${port} (TorBox ${apiKey ? 'configured' : 'NOT configured'})`);
});
