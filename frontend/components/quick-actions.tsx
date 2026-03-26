import { useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import * as icons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuickActionsStore } from "@/stores/quick-actions";
import { useCommandPaletteStore } from "@/stores/command-palette";
import { getAction } from "@/lib/action-registry";
import { executeAction } from "@/lib/action-executor";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";

/**
 * Convert a kebab-case icon name from the action registry to a PascalCase
 * Lucide component reference.
 */
function getIconComponent(iconName: string): LucideIcon {
  const pascalCase = iconName
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (icons as Record<string, LucideIcon>)[pascalCase] ?? icons.CircleDot;
}

const BUTTON_CLASS =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-ctp-overlay1 transition-colors hover:bg-ctp-surface0 hover:text-ctp-text";

export function QuickActions() {
  const actions = useQuickActionsStore((s) => s.actions);
  const loaded = useQuickActionsStore((s) => s.loaded);
  const loadActions = useQuickActionsStore((s) => s.loadActions);
  const openPalette = useCommandPaletteStore((s) => s.open);

  useEffect(() => {
    if (!loaded) {
      loadActions();
    }
  }, [loaded, loadActions]);

  return (
    <TooltipProvider delayDuration={500}>
    <div className="flex items-center gap-0.5">
      {actions.map(({ actionId }) => {
        const action = getAction(actionId);
        if (!action) return null;

        const Icon = getIconComponent(action.icon);
        const tooltipLabel = action.shortcut
          ? `${action.label} (${action.shortcut})`
          : action.label;

        return (
          <ContextMenu key={actionId}>
            <ContextMenuTrigger asChild>
              <span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={action.label}
                      className={BUTTON_CLASS}
                      onClick={() => executeAction(actionId)}
                    >
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {tooltipLabel}
                  </TooltipContent>
                </Tooltip>
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => useQuickActionsStore.getState().removeAction(actionId)}
                className="text-ctp-red"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                Remove from quick actions
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Add quick action"
            className={cn(BUTTON_CLASS, "text-ctp-overlay0")}
            onClick={() => openPalette("quick-actions")}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Add quick action
        </TooltipContent>
      </Tooltip>
    </div>
    </TooltipProvider>
  );
}
