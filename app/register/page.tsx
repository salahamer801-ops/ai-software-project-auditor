import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getSessionUserSafe } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getSessionUserSafe();
  if (user) redirect("/dashboard");
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <AuthForm mode="register" />
    </div>
  );
}
