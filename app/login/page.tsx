import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getSessionUserSafe } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>;
}) {
  const user = await getSessionUserSafe();
  if (user) redirect("/dashboard");
  const params = await searchParams;
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <AuthForm mode="login" autoDemo={params.demo === "1"} />
    </div>
  );
}
