// app/shared-learning/layout.tsx
// The page here is a client component, which cannot read the server flag, so this server layout
// holds the launch gate for it (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings the
// route back. The middleware answers 404 first; this is the second line if its matcher ever skips.

import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export default function SharedLearningLayout({ children }: { children: React.ReactNode }) {
  if (isHiddenRoute("/shared-learning")) notFound();
  return children;
}
