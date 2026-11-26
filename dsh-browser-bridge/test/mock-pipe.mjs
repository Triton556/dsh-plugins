import { EventEmitter } from 'node:events';

export function connect() {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.end = () => {};
  socket.destroy = () => {};
  socket.write = (input) => {
    const request = JSON.parse(input);
    if (request.cmd === 'eof') { socket.emit('end'); return; }
    const reply = JSON.stringify({
      id: request.cmd === 'wrong-id' ? 'wrong' : request.id,
      ok: true, data: { title: 'Проверка' },
    }) + '\n';
    socket.emit('data', reply.slice(0, 8));
    socket.emit('data', reply.slice(8));
  };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}
