export function App() {
	return (
		<main
			style={{
				fontFamily: "system-ui, sans-serif",
				padding: 32,
				height: "100vh",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<h1 style={{ fontSize: 50, color: "red", fontWeight: 800 }}>
				Pincer Demo
			</h1>
			<p>
				Open the crab launcher or press Alt+Shift+P, then use Settings to
				customize either.
			</p>
			<button
				type="button"
				className="btn"
				style={{ position: "absolute", top: 0, right: 0 }}
			>
				Submit
			</button>
		</main>
	);
}
