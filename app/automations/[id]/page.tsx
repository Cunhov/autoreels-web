"use client";
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AutomationEditor from "@/components/ig-automation/AutomationEditor";

function EditAutomationContent() {
    const params = useParams<{ id: string | string[] }>();
    const searchParams = useSearchParams();
    const rawId = params?.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const openSimulator = searchParams.get("simulate") === "1";

    if (!id) {
        return (
            <div className="p-12 text-center text-ios-text-secondary">
                Automação não encontrada.
            </div>
        );
    }

    return (
        <AutomationEditor
            automationId={id}
            initialSimulatorOpen={openSimulator}
        />
    );
}

export default function EditAutomationPage() {
    return (
        <Suspense
            fallback={
                <div className="flex justify-center p-20">
                    <div className="w-8 h-8 border-2 border-ios-blue border-t-transparent rounded-full animate-spin" />
                </div>
            }
        >
            <EditAutomationContent />
        </Suspense>
    );
}
