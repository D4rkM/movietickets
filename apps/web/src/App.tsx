import { useState } from "react";
import { SeatMap } from "./features/seating/SeatMap";

export function App() {
  const [sessionId, setSessionId] = useState("");
  const [accessToken, setAccessToken] = useState("");

  return (
    <main style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>movietickets</h1>
      {/* Temporary manual inputs until routing/login exist — replace once those stories land. */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          placeholder="Session ID"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
        />
        <input
          placeholder="Access token"
          value={accessToken}
          onChange={(event) => setAccessToken(event.target.value)}
        />
      </div>
      {sessionId && accessToken ? (
        <SeatMap sessionId={sessionId} accessToken={accessToken} />
      ) : (
        <p>Informe o session ID e o access token pra ver o mapa de assentos.</p>
      )}
    </main>
  );
}

export default App;
