import ScreenView from "@/app/components/ScreenView";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const metadata = {
  title: "Origination screen · Engine B",
};

export default function ScreenPage() {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/screen")) notFound();
  return <ScreenView />;
}
