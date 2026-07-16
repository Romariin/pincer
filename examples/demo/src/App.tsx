export function App() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, minHeight: "100vh" }}>
      <h1 style={{ fontSize: 50, color: "purple", fontWeight: 800 }}>Pincer Demo</h1>
      <p>Press Alt+P (Option+P on macOS), then click an element to edit it.</p>
      <button className="btn">Submit</button>
    </main>
  );
}
