// Files the tests read as text (the Editor page, the plan, the research reference), through Vite's `?raw`.
declare module "*?raw" {
  const text: string;
  export default text;
}
