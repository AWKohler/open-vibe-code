export type SimulatorProvider = "cloud" | "local";

// Read on the server at request time so changing the deployment environment
// does not require rebuilding a NEXT_PUBLIC flag into browser JavaScript.
export function simulatorProvider(): SimulatorProvider {
  const value = process.env.SIMULATOR_PROVIDER?.trim() || "cloud";
  if (value !== "cloud" && value !== "local") {
    throw new Error("SIMULATOR_PROVIDER must be cloud or local");
  }
  return value;
}
