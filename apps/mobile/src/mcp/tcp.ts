import { NativeModules } from "react-native";
import type TcpSocket from "react-native-tcp-socket";
import type { Connection, Listener, Listening } from "./listener";
import { encodeUtf8 } from "./utf8";

type Socket = InstanceType<typeof TcpSocket.Socket>;
type Server = InstanceType<typeof TcpSocket.Server>;

/** How long the phone may take to open the port before access reports a failure. */
export const LISTEN_TIMEOUT_MS = 10_000;

function connectionOf(socket: Socket): Connection {
  return {
    onData: (listener) =>
      socket.on("data", (data) => listener(typeof data === "string" ? encodeUtf8(data) : data)),
    onClose: (listener) => {
      let closed = false;
      const once = () => {
        if (closed) return;
        closed = true;
        listener();
      };
      socket.on("close", once);
      socket.on("error", once);
    },
    endWith: (bytes) => {
      try {
        socket.end(bytes);
      } catch {
        // The socket closed under us (the library throws on writes to a closed socket).
        socket.destroy();
      }
    },
    destroy: () => {
      socket.destroy();
    },
  };
}

/** How long a closed server keeps closing connections the phone accepted just before it closed. */
const LATE_CONNECTIONS_MS = 5_000;

/**
 * Closes the server and drops the listeners the library registered for it on its shared native
 * event emitter, which it never removes itself; each would keep the old listener and token in
 * memory. Connections accepted just before the close still arrive for a while, so the connection
 * listener goes last.
 */
function shutDown(server: Server): void {
  server.close();
  server._listeningListener?.remove();
  server._errorListener?.remove();
  setTimeout(() => server._connectionsListener?.remove(), LATE_CONNECTIONS_MS);
}

/**
 * Listens on every network interface (Wi-Fi, cellular, and Tailscale when it runs) and hands each
 * connection to the listener. Rejects when the port can't be opened in time. The library loads
 * only here, so the app starts even without its native module.
 */
export async function listenTcp(
  port: number,
  listener: Listener,
  onFailure: (error: Error) => void,
): Promise<Listening> {
  // Loading the library without its native module throws a fatal error, not a rejection.
  if (!NativeModules.TcpSockets) {
    throw new Error("This build of Polso can't serve agents. Install the latest build.");
  }
  const { default: Tcp } = await import("react-native-tcp-socket");
  return new Promise((resolve, reject) => {
    let accept = (socket: Socket) => listener.accept(connectionOf(socket));
    const server = Tcp.createServer({}, (socket) => accept(socket));
    let listening = false;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      listener.stop();
      // Late connections are closed here rather than handed to the stopped listener.
      accept = (socket) => socket.destroy();
      // The library can only close a server that is listening. One that is still opening the
      // port is shut down when it gets there.
      if (listening) shutDown(server);
    };
    const fail = (error: Error, portOpening: boolean) => {
      clearTimeout(timer);
      close();
      if (!portOpening) shutDown(server);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("The port didn't open in time."), true),
      LISTEN_TIMEOUT_MS,
    );
    const failToOpen = (error: Error) => fail(error, false);
    server.once("error", failToOpen);
    server.listen({ port, host: "0.0.0.0", reuseAddress: true }, () => {
      listening = true;
      if (closed) {
        shutDown(server);
        return;
      }
      clearTimeout(timer);
      server.off("error", failToOpen);
      // A later failure closes the server and is reported, so the app shows access as stopped.
      server.on("error", (error) => {
        if (closed) return;
        close();
        onFailure(error);
      });
      resolve({ close });
    });
  });
}
