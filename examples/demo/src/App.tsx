export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, height: "100vh", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 50, color: "purple", fontWeight: 800 }}>Pincer Demo</h1>
      <p>Press Alt+P (Option+P on macOS), then click an element to edit it.</p>
      <button className="btn" style={{ position: "absolute", top: 0, right: 0 }}>Submit</button>
    </main>
  );
}
