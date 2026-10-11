import { useState } from "react";
import { useMutation } from "convex/react";
import { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

export const useApiMutation = <Mutation extends FunctionReference<"mutation">>(
  mutationFunction: Mutation,
) => {
  const [pending, setPending] = useState(false);
  const apiMutation = useMutation(mutationFunction) as (
    payload: FunctionArgs<Mutation>,
  ) => Promise<FunctionReturnType<Mutation>>;

  const mutate = (payload: FunctionArgs<Mutation>) => {
    setPending(true);
    return apiMutation(payload).finally(() => setPending(false));
  };

  return {
    mutate,
    pending,
  };
};
