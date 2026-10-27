// Small holder for the socket.io server so any module can push live updates to the dashboard.
let io = null;

export function setIo(server) {
  io = server;
}

export function emit(event, payload) {
  io?.emit(event, payload);
}
