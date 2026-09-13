"use client";

import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { ChangeEvent, useEffect, useState } from "react";
import qs from "query-string";

export const SearchInput = () => {
    const router = useRouter();
    const [value, setValue] = useState("");
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedValue(value), 500);
        return () => clearTimeout(t);
    }, [value]);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        setValue(e.target.value);
    }

    useEffect(() => {
        const url = qs.stringifyUrl({
            url: "/",
            query: { 
                search: debouncedValue,
            },
        },{ skipEmptyString: true, skipNull: true })

        router.push(url);
    },[debouncedValue, router]);

  return (
    <div className="w-full relative">
      <Search className="absolute top-1/2 left-3 tranform -translate-y-1/2 text-muted-foreground h-4 w-4"/>
      <Input
        className="w-full max-w-[516px] pl-9"
        placeholder="Search Boards"
        onChange={handleChange}
      />
    </div>
  );
};
