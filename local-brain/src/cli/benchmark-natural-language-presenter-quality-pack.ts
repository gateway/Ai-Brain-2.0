import { closePool } from "../db/client.js";
import { runNaturalLanguagePresenterQualityPackCli } from "../benchmark/natural-language-presenter-quality-pack.js";

try {
  await runNaturalLanguagePresenterQualityPackCli();
} finally {
  await closePool().catch(() => undefined);
}
