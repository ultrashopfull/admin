try {
  const theme = localStorage.getItem("nova-theme");
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}
