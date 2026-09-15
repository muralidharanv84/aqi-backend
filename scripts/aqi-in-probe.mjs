// Node 22.6+; import the same dependency-free TypeScript that runs in Workers.
import { fetchAqiReading } from "../src/aqi-in/client.ts";

try {
  console.log(JSON.stringify(await fetchAqiReading(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "AQI request failed");
  process.exitCode = 1;
}
