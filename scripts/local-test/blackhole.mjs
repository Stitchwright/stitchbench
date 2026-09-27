// A hub that has gone silent: accepts every connection on the port and never answers (a dead internet link looks
// like this from the shop; connections don't fail, they wait).
import net from "node:net";
const port = Number(process.argv[2] ?? 3200);
net
  .createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {}); // read and discard, so the client thinks it got through
  })
  .listen(port, "0.0.0.0", () => console.log(`black hole on :${port}`));
