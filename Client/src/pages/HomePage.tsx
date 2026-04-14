import { useState } from "react";
import Card from "@/components/Card";
import api from "@/services/api";

const HomePage = () => {
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

  const frontend = {
    title: "Frontend Stack",
    items: ["React", "Vite", "TypeScript", "Tailwind", "Axios", "React Router DOM"]
  }

  const backend = {
    title: "Backend Stack",
    items: ["Node", "Express", "TypeScript", "Cors", "Dotenv", "Nodemon"]
  }

  const tryConnection = async () => {
    try {
      const res = await api.get("/sample/message");
      console.log(res.data.message);
      setStatus("success");
    } catch (error) {
      console.error(error);
      setStatus("error");
    }
  }

  return (
    <div className="min-h-dvh bg-neutral-300 flex flex-col items-center justify-center gap-10">
      <div className="flex flex-col items-center justify-center">
        <p className="text-4xl font-bold text-neutral-800">
          Full-Stack Boilerplate
        </p>
        <p className="text-3xl text-neutral-700">
          React + Express + Node + TypeScript
        </p>
      </div>

      <div className="flex items-center justify-center gap-10">
        <Card
          title={frontend.title}
          items={frontend.items}
        />

        <Card
          title={backend.title}
          items={backend.items}
        />
      </div>

      <button
        onClick={tryConnection}
        className={`px-4 py-2 rounded-xl text-neutral-200 transition-colors duration-200 cursor-pointer 
          ${status === "success"
            ? "bg-green-600 hover:bg-green-500"
            : status === "error"
              ? "bg-red-600 hover:bg-red-500"
              : "bg-neutral-800 hover:bg-neutral-700"
          }`}
      >
        {status === "success"
          ? "✅ Connection Successful"
          : status === "error"
            ? "❌ Connection Failed"
            : "Try Connection"}
      </button>
    </div>
  )
}

export default HomePage
