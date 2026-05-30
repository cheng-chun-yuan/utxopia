import { redirect } from "next/navigation";

export default function SuiPage() {
  redirect("/vault?chain=sui");
}
