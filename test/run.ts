// test/run.ts - imports every test module, then runs the harness.
import "./prosegate.test";
import "./ladder.test";
import "./hash.test";
import "./screen.test";
import "./deepen.test";
import "./llm.test";
import "./ixbrl.test";
import "./kb.test";
import "./model.test";
import "./secEdgar.test";
import "./pdfAccounts.test";
import "./esef.test";
import "./auth.test";
import "./universeFromGraph.test";
import "./clientspec-render.test";
import "./wackySheets.test";
import "./llmProvider.test";
import "./vision.test";
import "./visionVerify.test";
import "./periodHeadings.test";
import "./pageFinding.test";
import "./basisCheck.test";
import "./groupCheck.test";
import "./figureBasis.test";
import "./capitalStructure.test";
import "./ukGold.test";
import "./ocrSecondRead.test";
import "./hybridSecondRead.test";
import "./ukRun.test";
import "./smokeProd.test";
import "./dbMigrate.test";
import "./beIdentities.test";
import "./beUkFormatTies.test";
import { registerLiveTests } from "./companiesHouseLive.test";
import { registerContractStoreTests } from "./contracts.test";
import { registerHostingTests } from "./hosting.test";
import { registerWorkspaceTests } from "./workspace.test";
import { registerFetchDocTests } from "./fetchDoc.test";
import { registerGleifTests } from "./gleif.test";
import { registerOcrTests } from "./ocr.test";
import { registerGraphTests } from "./graph.test";
import { registerOriginateTests } from "./originate.test";
import { registerOnboardingTests } from "./onboarding.test";
import { registerResolveTests } from "./resolve.test";
import { registerAuthFlowTests } from "./authFlow.test";
import { registerMergeTests } from "./merge.test";
import { registerPersistenceTests } from "./persistence.test";
import { registerCatalystsTests } from "./catalysts.test";
import { registerMonitorTests } from "./monitor.test";
import { registerScreenUniverseTests } from "./screenUniverse.test";
import { registerClientSpecInduceTests } from "./clientspec-induce.test";
import { registerClientSpecStoreTests } from "./clientspec-store.test";
import { registerClientSpecFeedbackTests } from "./clientspec-feedback.test";
import { registerClientSpecSharedTests } from "./clientspec-shared.test";
import { registerClientSpecPromoteTests } from "./clientspec-promote.test";
import { registerKbMasterIdTests } from "./kb-masterid.test";
import { registerKbStoreTests } from "./kb-store.test";
import { registerKbIngestTests } from "./kb-ingest.test";
import { registerKbInstrumentTests } from "./kb-instrument.test";
import { registerKbKnownUnknownsTests } from "./kb-knownunknowns.test";
import { registerKbExportPolicyTests } from "./kb-exportpolicy.test";
import { registerProdGuardTests } from "./prodGuard.test";
import { registerResolveNameTests } from "./resolveName.test";
import { registerFilingsTests } from "./filings.test";
import { registerVisionLiveTests } from "./visionLive.test";
import { registerRunJobTests } from "./runJob.test";
import { registerGroupTests } from "./group.test";
import { registerQa03Tests } from "./qa03.test";
import { registerQa05Tests } from "./qa05.test";
import { registerQa06Tests } from "./qa06.test";
import { registerQa05bTests } from "./qa05b.test";
import { registerModelLiveTests } from "./modelLive.test";
import { registerDs05Tests } from "./ds05.test";
import { registerAuthWallTests } from "./authWall.test";
import { registerChHttpTests } from "./chHttp.test";
import { registerFe01Tests } from "./fe01.test";
import { registerRunEntryTests } from "./runEntry.test";
import { run } from "./harness";

// WP-BE14: Companies House calls now retry with backoff and share a pacer. The suite stubs fetch,
// so waiting real milliseconds between attempts would only slow it down. Read at call time.
process.env.CH_RETRY_BASE_MS ??= "1";
process.env.CH_MIN_INTERVAL_MS ??= "0";

// Any failure, anywhere, must fail the run. A rejection nobody awaited counts as a failure
// and a thrown error outside a test does too.
let unhandled = 0;
process.on("unhandledRejection", (reason) => {
  unhandled++;
  console.log(`  FAIL  unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

// If the event loop drains while a test is still pending (an awaited promise that can never
// settle), Node exits without ever reaching process.exit below. Treat that as a failure
// instead of letting the process exit 0.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.log("\n  FAIL  the run ended before every test finished (a promise never settled)");
    process.exitCode = 1;
  }
});

// The live-data suite registers its cases after mocked async fetch work, so await it
// before running. Synchronous suites above have already registered on import.
async function main() {
  await registerLiveTests();
  await registerContractStoreTests();
  await registerHostingTests();
  await registerWorkspaceTests();
  await registerFetchDocTests();
  await registerGleifTests();
  await registerOcrTests();
  await registerGraphTests();
  await registerOriginateTests();
  await registerOnboardingTests();
  await registerResolveTests();
  await registerAuthFlowTests();
  await registerMergeTests();
  await registerPersistenceTests();
  await registerCatalystsTests();
  await registerMonitorTests();
  await registerScreenUniverseTests();
  await registerClientSpecInduceTests();
  await registerClientSpecStoreTests();
  await registerClientSpecFeedbackTests();
  await registerClientSpecSharedTests();
  await registerClientSpecPromoteTests();
  await registerKbMasterIdTests();
  await registerKbStoreTests();
  await registerKbIngestTests();
  await registerProdGuardTests();
  await registerKbInstrumentTests();
  await registerKbKnownUnknownsTests();
  await registerKbExportPolicyTests();
  await registerResolveNameTests();
  await registerFilingsTests();
  await registerVisionLiveTests();
  await registerRunJobTests();
  await registerGroupTests();
  await registerQa03Tests();
  await registerQa05Tests();
  await registerQa06Tests();
  await registerQa05bTests();
  await registerModelLiveTests();
  await registerDs05Tests();
  await registerAuthWallTests();
  await registerChHttpTests();
  await registerFe01Tests();
  await registerRunEntryTests();
  // run() awaits every test, sync or async, in registration order before it returns.
  const failed = await run();
  // Let any late rejection from a test's stray promise surface before deciding the exit code.
  await new Promise((resolve) => setImmediate(resolve));
  if (unhandled > 0) console.log(`${unhandled} unhandled rejection(s)`);
  finished = true;
  process.exit(failed > 0 || unhandled > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log(`  FAIL  test registration threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  finished = true;
  process.exit(1);
});

// WP-BE11: the references pack. Imports are hoisted, so its cases register before main() runs.
import "./references.test";
// WP-BE09: the branded deck. Imports are hoisted, so its cases register before main() runs.
import "./deck.test";
// WP-DS04, WP-DS08: the release preflight. Imports are hoisted, so its cases register before main() runs.
import "./preflight.test";
// WP-QA05 hardening: CSP and static headers on every host, no X-Powered-By, fixtures-mode runs.
import "./qa05c.test";
// WP-QA05: the narrative site's landing carries Tearline, no working title, no vercel.app host.
import "./siteLanding.test";
