import type { Role } from "@/generated/prisma/enums";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      shopId: string;
      sv?: number;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    shopId?: string;
    sv?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: Role;
    shopId?: string;
    sv?: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    role?: Role;
    shopId?: string;
    sv?: number;
  }
}
