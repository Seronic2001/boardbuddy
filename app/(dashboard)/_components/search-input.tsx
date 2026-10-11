"use client";

import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChangeEvent, useEffect, useState } from "react";

export const SearchInput = () => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [value, setValue] = useState(searchParams.get("search") ?? "");

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setValue(e.target.value);
    }

    useEffect(() => {
        const t = setTimeout(() => {
            // Read the live URL so other params (e.g. favorites) are preserved.
            const params = new URLSearchParams(window.location.search);

            if (value === (params.get("search") ?? "")) return;

            if (value) {
                params.set("search", value);
            } else {
                params.delete("search");
            }

            const query = params.toString();

            router.replace(query ? `/?${query}` : "/");
        }, 500);

        return () => clearTimeout(t);
    },[value, router]);

  return (
    <div className="w-full relative">
      <Search className="absolute top-1/2 left-3 tranform -translate-y-1/2 text-muted-foreground h-4 w-4"/>
      <Input
        className="w-full max-w-[516px] pl-9"
        placeholder="Search Boards"
        value={value}
        onChange={handleChange}
      />
    </div>
  );
};
