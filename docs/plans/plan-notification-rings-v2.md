# Plan: Sistema de Notificação Rico v2 — Corrigido e Melhorado

**Priority:** High
**Date:** 2026-03-23
**Status:** Ready for implementation
**Supersedes:** `plan-notification-rings.md`

---

## 1. Visão Geral e Motivação

O plano original (`plan-notification-rings.md`) estava correto em suas intenções, mas apresentava lacunas importantes após análise profunda da codebase e referências externas:

### Problemas no plano original

1. **Captura de mensagem de notificação via PTY buffer**: O plano propunha capturar a última linha do buffer PTY (`terminal-tabs.ts`) para usar como texto de notificação. Isso é complexo e frágil — o buffer contém sequências VT/ANSI brutas que precisariam ser parseadas. Além disso, `terminal-tabs.ts` não tem acesso direto ao buffer PTY.

2. **Arquitetura de hook desconhecida**: Tanto cmux (macOS/Ghostty) quanto superset (Electron) usam um sistema de **hook externo** — um shell script injetado via variável de ambiente (`CLAUDE_HOOKS_DIR`, `SUPERSET_TAB_ID`) — que chama de volta para a aplicação via socket/HTTP quando o AI agent termina, precisa de input, ou está em progresso. O plano original ignorou esse padrão arquitetural.

3. **onRenderTabSet no arquivo errado**: O plano indicava modificar `App.tsx`. O correto é `frontend/components/tiling-layout.tsx`, onde `onRenderTabSet` já existe e é implementado.

4. **Mapeamento de status incompleto**: O plano tinha apenas "notified" (binário). O correto (baseado em superset e cmux) é um sistema de **prioridade de status**: `idle → review → working → permission`.

5. **A chamada `markProjectNotified` existe mas não é chamada**: No fluxo atual, `setProjectSessionState` é chamado em `App.tsx` quando o `pty:session-state-changed` chega, mas `markProjectNotified` nunca é invocado. O plano original não identificou esse gap.

### O que realmente funciona hoje

- `pty:session-state-changed` (Electron → Renderer) via IPC quando PTY sai
- `setProjectSessionState` → adiciona ao `unreadProjects` quando exited e não é projeto ativo
- Badge verde já existe em `project-sidebar.tsx` via `notifiedProjects`, mas `markProjectNotified` nunca é chamado
- `onRenderTabSet` já existe em `tiling-layout.tsx` com lógica para file-tree
- `onRenderTab` já existe com `STATE_CLASSES` (thinking, ready, exited, idle) para dots nos tabs

### O que cmux e superset ensinam

**cmux** (Swift, macOS Ghostty terminal):
- Usa hook via variável de ambiente (`CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`) injetada no shell do AI
- AI chama `cmux notify --title "..." --body "..."` quando quer notificar
- Estrutura: `NotificationInfo { id, workspaceId, surfaceId, isRead, title, subtitle, body }`
- Notificações são listas gerenciadas por workspace/surface ID
- "Surface" = equivalente ao nosso "tab", "Workspace" = equivalente ao nosso "project"

**superset** (Electron, TypeScript — arquitetura mais próxima do Forja):
- Hook shell script (`notify-hook.template.sh`) injetado via `SUPERSET_TAB_ID` + `SUPERSET_PANE_ID` + `SUPERSET_WORKSPACE_ID`
- Claude Code usa `hook_event_name` no JSON; Codex usa `type: "agent-turn-complete"`
- Hook faz HTTP GET para `localhost:PORT/hook/complete?eventType=...&tabId=...`
- Tipos de evento mapeados: `Start`, `Stop`, `PermissionRequest`
- **Status do pane**: `idle | working | permission | review` com prioridade numérica
- **Supressão inteligente**: não notifica se o pane já está visível e focado
- **StatusIndicator**: dot pulsante vermelho (permission), âmbar (working), verde estático (review)

### Adaptação para o Forja

O Forja já tem a metade do caminho via `pty:session-state-changed`. A abordagem mais simples e correta é:

1. **Não implementar hook externo neste plano** — é uma feature separada e maior. O `pty:session-state-changed` existente é suficiente para MVP.
2. **Adotar o modelo de status priorizado** do superset: `idle → review → working → permission`.
3. **Corrigir o gap**: chamar `markProjectNotified` no handler de `pty:session-state-changed` quando o projeto não está ativo.
4. **Visual rings no tabset**: via `onRenderTabSet` em `tiling-layout.tsx` (não `App.tsx`).
5. **Mensagem de notificação**: usar texto fixo por enquanto ("Session finished", "Session running") — sem parsear buffer PTY.

---

## 2. Análise do Estado Atual

### O que existe e funciona

**`frontend/stores/projects.ts`:**
- `unreadProjects: Set<string>` — projetos com atividade não lida
- `thinkingProjects: Set<string>` — projetos com sessão ativa
- `notifiedProjects: Set<string>` — projetos com badge, mas **nunca populado** (gap!)
- `markProjectNotified(projectPath)` — existe mas não é chamado em nenhum lugar
- `setProjectSessionState` — chamado em `App.tsx` quando PTY exit chega

**`frontend/App.tsx` (linhas 668–685):**
```ts
const unlistenState = listen("pty:session-state-changed", (event) => {
  const { projectPath, state } = event.payload;
  if (state === "exited") {
    // Aqui: markProjectNotified NUNCA é chamado!
    useProjectsStore.getState().setProjectSessionState(projectPath, ...);
  }
});
```

**`frontend/components/tiling-layout.tsx`:**
- `onRenderTabSet` já existe — adiciona botões para file-tree
- `onRenderTab` já existe — renderiza dots de estado por session
- `STATE_CLASSES`: `{ thinking, ready, exited, idle }` — mapeado em `session-state` store

**`frontend/stores/session-state.ts`:**
- Contém por-tab o estado (`thinking`, `ready`, `exited`, `idle`) baseado em output parsing
- Este é o local correto para pane-level state, diferente do project-level state

**`frontend/components/project-sidebar.tsx`:**
- `ProjectIcon` já tem `showBadge` baseado em `notifiedProjects` — mas como `notifiedProjects` nunca é populado, o badge nunca aparece
- Badge: `className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-ctp-green ring-1 ring-ctp-mantle"` — sem animação

### O que está faltando

| Gap | Impacto | Prioridade |
|-----|---------|-----------|
| `markProjectNotified` nunca chamado | Badge verde nunca aparece | **Crítico** |
| `notificationMessages` inexistente | Tooltip sem contexto | Médio |
| Visual ring no tabset | Ring em pane ausente | Alto |
| Badge sem animação | Difícil de notar | Médio |
| Atalho Alt+N | Navegação entre notificações | Baixo |

---

## 3. Modelo de Status Melhorado

Inspirado no superset, adotar prioridade de status no nível de projeto:

```ts
// Novo tipo em frontend/stores/projects.ts
export type ProjectNotificationStatus = "idle" | "review" | "permission";
// "idle" = sem notificação
// "review" = sessão terminou, aguarda revisão (verde)
// "permission" = sessão precisa de input (vermelho pulsante) — futuro
```

Por ora, implementar apenas `idle` e `review`. `permission` virá quando o hook externo for implementado.

---

## 4. Plano de Implementação Passo a Passo

### Step 1: Corrigir o gap crítico — chamar `markProjectNotified` em `App.tsx`

**Arquivo:** `frontend/App.tsx`

No handler de `pty:session-state-changed`, adicionar a chamada:

```ts
const unlistenState = listen("pty:session-state-changed", (event) => {
  const { projectPath, state } = event.payload;
  if (state === "exited") {
    const projectTabs = useTerminalTabsStore.getState().getTabsForProject(projectPath);
    const anyRunning = projectTabs.some((t) => t.isRunning);
    useProjectsStore.getState().setProjectSessionState(
      projectPath,
      anyRunning ? "running" : "exited",
    );
    // FIX: chamar markProjectNotified aqui
    if (!anyRunning) {
      useProjectsStore.getState().markProjectNotified(projectPath);
    }
  } else {
    useProjectsStore.getState().setProjectSessionState(projectPath, state);
  }
});
```

**Nota:** `markProjectNotified` já verifica se o projeto é o ativo (`if (s.activeProjectPath === projectPath) return {}`), então é seguro chamar sem verificação adicional.

### Step 2: Adicionar `notificationMessages` ao projects store

**Arquivo:** `frontend/stores/projects.ts`

Adicionar ao `ProjectsState`:
```ts
notificationMessages: Record<string, string>;
setProjectNotificationMessage: (projectPath: string, message: string) => void;
clearProjectNotificationMessage: (projectPath: string) => void;
```

Atualizar `markProjectNotified` para aceitar mensagem opcional:
```ts
markProjectNotified: (projectPath: string, message?: string) => void;
```

Implementação:
```ts
notificationMessages: {},

setProjectNotificationMessage: (projectPath, message) => {
  set((s) => ({
    notificationMessages: { ...s.notificationMessages, [projectPath]: message },
  }));
},

clearProjectNotificationMessage: (projectPath) => {
  set((s) => {
    const next = { ...s.notificationMessages };
    delete next[projectPath];
    return { notificationMessages: next };
  });
},

markProjectNotified: (projectPath, message) => {
  set((s) => {
    if (s.activeProjectPath === projectPath) return {};
    const next = new Set(s.notifiedProjects);
    next.add(projectPath);
    const msgs = message
      ? { ...s.notificationMessages, [projectPath]: message }
      : s.notificationMessages;
    return { notifiedProjects: next, notificationMessages: msgs };
  });
},
```

Atualizar `clearProjectNotified` para também limpar a mensagem:
```ts
clearProjectNotified: (projectPath) => {
  set((s) => {
    const next = new Set(s.notifiedProjects);
    next.delete(projectPath);
    const msgs = { ...s.notificationMessages };
    delete msgs[projectPath];
    return { notifiedProjects: next, notificationMessages: msgs };
  });
},
```

Atualizar chamada em `App.tsx` (Step 1) para passar mensagem:
```ts
useProjectsStore.getState().markProjectNotified(projectPath, "Session finished");
```

### Step 3: Enriquecer tooltip do sidebar com mensagem de notificação

**Arquivo:** `frontend/components/project-sidebar.tsx`

Adicionar `notificationMessages` ao que é extraído do store:
```ts
const { ..., notificationMessages } = store;
```

Passar como prop para `SortableProjectIcon` → `ProjectIcon`:
```ts
notificationMessage?: string;
```

Atualizar `TooltipContent` em `ProjectIcon`:
```tsx
<TooltipContent side="right" className="max-w-xs">
  <p className="font-semibold">{project.name}</p>
  {isNotified && notificationMessage && (
    <p className="text-app-sm text-ctp-green mt-1 line-clamp-2">
      {notificationMessage}
    </p>
  )}
  <p className="text-app-sm text-ctp-overlay1">{project.path}</p>
</TooltipContent>
```

### Step 4: Adicionar animação pulse ao badge do sidebar

**Arquivo:** `frontend/components/project-sidebar.tsx`

Atualizar o badge em `ProjectIcon`:
```tsx
{showBadge && (
  <span
    data-testid={`session-badge-${project.path}`}
    className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-ctp-green ring-1 ring-ctp-mantle animate-pulse"
    aria-label={`${project.name} session finished`}
  />
)}
```

### Step 5: Adicionar per-tab notification state ao session-state store

**Arquivo:** `frontend/stores/session-state.ts`

Analisar o store para entender sua estrutura atual, então adicionar por-tab um campo para indicar se o tab tem notificação pendente (para uso no visual ring do tabset).

**Nota:** Verificar se `session-state.ts` já tem algo semelhante antes de criar campos redundantes. O objetivo é saber quais tabs têm status "review" (exited com usuário não tendo visto) para identificar quais tabsets precisam do ring.

### Step 6: Adicionar visual ring no tabset via `onRenderTabSet`

**Arquivo:** `frontend/components/tiling-layout.tsx`

O `onRenderTabSet` já existe. Estendê-lo para detectar tabsets com tabs notificadas:

```tsx
const onRenderTabSet = useCallback(
  (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    const children = node.getChildren() ?? [];
    const hasFileTree = children.some(
      (child) => (child as TabNode).getComponent?.() === "file-tree",
    );

    // Verificar se algum tab neste tabset tem estado "exited" não lido
    const hasNotifiedTab = children.some((child) => {
      const tabNode = child as TabNode;
      const component = tabNode.getComponent?.();
      if (component !== "terminal") return false;
      const tabId = tabNode.getId();
      // Usar notifiedTabs do novo campo no store
      return notifiedTabs.has(tabId);
    });

    if (hasNotifiedTab) {
      // Usar seterValues.headerContent para injetar o ring visual
      // (ring é um overlay absoluto sobre o header do tabset)
      const prevHeader = renderValues.headerContent;
      renderValues.headerContent = (
        <>
          {prevHeader}
          <span
            className="pointer-events-none absolute inset-0 rounded ring-1 ring-ctp-green ring-offset-0"
            aria-hidden="true"
          />
        </>
      );
    }

    // ... lógica file-tree existente
  },
  [notifiedTabs], // dependência do novo estado
);
```

**Alternativa mais simples e segura**: Usar `renderValues.buttons` para adicionar um dot indicador no header do tabset (sem CSS ring absoluto que pode conflitar com o FlexLayout):

```tsx
if (hasNotifiedTab) {
  renderValues.buttons.unshift(
    <span
      key="notif-ring"
      className="relative flex h-2 w-2 shrink-0 mr-1"
      aria-label="Unread notification"
    >
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ctp-green opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-ctp-green" />
    </span>
  );
}
```

**Decisão de abordagem**: A opção com `buttons` (dot no header) é mais robusta. O ring CSS absoluto pode conflitar com a renderização do FlexLayout e é difícil de posicionar corretamente. O dot pulsante no header do tabset é o padrão adotado pelo superset (`StatusIndicator` com `animate-ping`).

### Step 7: Implementar `notifiedTabs` no tiling-layout store para tracking por tab

Para que o `onRenderTabSet` em `tiling-layout.tsx` saiba quais tabsets têm notificações, é mais limpo manter esse estado no `tiling-layout` store ou ler diretamente do `terminal-tabs` store + `projects` store.

**Abordagem recomendada — derivada, sem novo estado:**

No `onRenderTabSet`, verificar se algum filho do tabset é um terminal tab cujo `path` pertence a um projeto em `notifiedProjects`:

```tsx
// Dentro do onRenderTabSet:
const notifiedProjects = useProjectsStore.getState().notifiedProjects;
const tabs = useTerminalTabsStore.getState().tabs;

const hasNotifiedTab = children.some((child) => {
  const tabId = (child as TabNode).getId();
  const tab = tabs.find((t) => t.id === tabId);
  return tab && notifiedProjects.has(tab.path);
});
```

Isso evita criar estado redundante e usa diretamente os stores existentes. **Porém**, para que o componente re-renderize quando `notifiedProjects` muda, o componente `TilingLayout` precisa subscrever ao store de projetos.

**Implementação no componente:**
```tsx
// No TilingLayout component, adicionar:
const notifiedProjects = useProjectsStore((s) => s.notifiedProjects);
const allTabs = useTerminalTabsStore((s) => s.tabs);
```

E usar essas dependências no `onRenderTabSet` via closure.

### Step 8: Limpar notificação do tabset ao focar

**Arquivo:** `frontend/components/tiling-layout.tsx`

No `onAction` do FlexLayout, detectar quando o usuário seleciona um tab e limpar a notificação do projeto correspondente:

```tsx
// No handler de Actions já existente:
if (action.type === Actions.SET_ACTIVE_TABSET || action.type === Actions.SELECT_TAB) {
  const nodeId = action.data?.node as string | undefined;
  if (nodeId) {
    const tab = useTerminalTabsStore.getState().tabs.find((t) => t.id === nodeId);
    if (tab) {
      // Limpar notificação quando o usuário foca um tab de projeto notificado
      const activeProjectPath = useProjectsStore.getState().activeProjectPath;
      if (tab.path === activeProjectPath) {
        useProjectsStore.getState().clearProjectNotified(tab.path);
      }
    }
  }
}
```

**Nota:** A notificação do sidebar já é limpa automaticamente quando o usuário troca de projeto via `switchToProject` → `clearProjectNotified`. A limpeza adicional aqui é para quando o usuário já está no projeto mas foca um tab específico.

### Step 9: Implementar atalho Alt+N — pular para próxima notificação

**Arquivo:** `frontend/hooks/use-keyboard-shortcuts.ts`

Adicionar ao handler existente (após os outros atalhos):

```ts
// Alt+N — pular para próximo projeto com notificação pendente
if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "n") {
  event.preventDefault();
  const { projects, activeProjectPath, notifiedProjects, switchToProject } =
    useProjectsStore.getState();
  const unread = projects.filter((p) => notifiedProjects.has(p.path));
  if (unread.length === 0) return;

  const activeIdx = projects.findIndex((p) => p.path === activeProjectPath);
  // Pegar o próximo não lido após o projeto atual (com wrap-around)
  const next =
    unread.find((p) => {
      const idx = projects.findIndex((pp) => pp.path === p.path);
      return idx > activeIdx;
    }) ?? unread[0];

  if (next) switchToProject(next.path);
  return;
}
```

---

## 5. Arquivos a Criar/Modificar

| Arquivo | Ação | Descrição |
|---------|------|-----------|
| `frontend/App.tsx` | Modificar | Chamar `markProjectNotified` no handler de `pty:session-state-changed` |
| `frontend/stores/projects.ts` | Modificar | Adicionar `notificationMessages`, atualizar `markProjectNotified` e `clearProjectNotified` |
| `frontend/components/project-sidebar.tsx` | Modificar | Exibir mensagem no tooltip, adicionar `animate-pulse` ao badge |
| `frontend/components/tiling-layout.tsx` | Modificar | `onRenderTabSet` com dot pulsante indicador de notificação; subscrição a `notifiedProjects` |
| `frontend/hooks/use-keyboard-shortcuts.ts` | Modificar | Adicionar handler `Alt+N` para jump-to-unread |

**Arquivos NÃO modificados** (comparado ao plano original):
- `frontend/stores/tiling-layout.ts` — não precisamos de `notifiedTabsets` separado
- `frontend/stores/terminal-tabs.ts` — não precisamos parsear buffer PTY

---

## 6. Estratégia de Testes (TDD)

### Step 1 — Testes do projects store

**Arquivo:** `frontend/stores/__tests__/projects.test.ts`

```ts
describe("notification messages", () => {
  it("markProjectNotified stores message when provided", () => {
    const store = useProjectsStore.getState();
    store.markProjectNotified("/path/to/project", "Session finished");
    expect(store.notificationMessages["/path/to/project"]).toBe("Session finished");
    expect(store.notifiedProjects.has("/path/to/project")).toBe(true);
  });

  it("markProjectNotified without message does not overwrite existing message", () => {
    // ...
  });

  it("clearProjectNotified also removes message", () => {
    // ...
  });

  it("markProjectNotified is no-op when project is active", () => {
    // ...
  });
});
```

### Step 2 — Testes do App.tsx (via mocks)

**Arquivo:** `frontend/__tests__/app-session-state.test.ts` (novo ou existente)

```ts
it("calls markProjectNotified when session exits for non-active project", () => {
  // Mock listen, simular pty:session-state-changed com state=exited
  // Verificar que markProjectNotified foi chamado com projectPath e "Session finished"
});

it("does not call markProjectNotified when active project session exits", () => {
  // ...
});

it("does not call markProjectNotified when other tabs still running", () => {
  // ...
});
```

### Step 3 — Testes do ProjectIcon

**Arquivo:** `frontend/components/__tests__/project-sidebar.test.tsx`

```ts
it("badge has animate-pulse class when isNotified", () => {
  // render ProjectIcon com isNotified=true
  // verificar className do badge inclui "animate-pulse"
});

it("tooltip shows notification message when isNotified and message provided", () => {
  // render com isNotified=true, notificationMessage="Session finished"
  // verificar que texto aparece no tooltip
});

it("tooltip does not show notification message when isNotified is false", () => {
  // ...
});
```

### Step 4 — Testes do keyboard shortcut

**Arquivo:** `frontend/hooks/__tests__/use-keyboard-shortcuts.test.ts`

```ts
it("Alt+N switches to first unread project", () => {
  // Mock projects store com notifiedProjects
  // Disparar evento keydown com altKey=true, key="n"
  // Verificar que switchToProject foi chamado
});

it("Alt+N cycles to next unread after current", () => {
  // ...
});

it("Alt+N is no-op when no notified projects", () => {
  // ...
});
```

---

## 7. Ordem de Implementação (Red-Green-Refactor)

| Task | Arquivo(s) | Tipo |
|------|-----------|------|
| T1 | `projects.test.ts` + `projects.ts` | Testes + Store: notificationMessages |
| T2 | `app-session-state.test.ts` + `App.tsx` | Testes + Fix: markProjectNotified gap |
| T3 | `project-sidebar.test.tsx` + `project-sidebar.tsx` | Testes + UI: tooltip + pulse badge |
| T4 | `tiling-layout.tsx` | UI: notification dot no tabset header |
| T5 | `use-keyboard-shortcuts.test.ts` + `use-keyboard-shortcuts.ts` | Testes + Feature: Alt+N |

---

## 8. Critérios de Aceite

- [ ] Quando sessão AI termina em projeto background, badge verde **pulsa** no sidebar
- [ ] Badge não aparece se o projeto já está ativo no momento do exit
- [ ] Badge é limpo ao trocar para o projeto notificado
- [ ] Tooltip do projeto notificado exibe "Session finished" (ou mensagem customizada)
- [ ] Tabset que contém terminal de projeto notificado exibe dot pulsante verde no header
- [ ] Dot desaparece quando usuário foca o tab
- [ ] `Alt+N` navega para o próximo projeto com notificação pendente
- [ ] `Alt+N` é no-op quando nenhum projeto tem notificação
- [ ] `Alt+N` tem wrap-around (último projeto vai para o primeiro da lista)
- [ ] Todos os testes existentes continuam passando
- [ ] Novos testes cobrem todos os novos comportamentos

---

## 9. Decisões de Arquitetura

### Por que NÃO implementar hook externo agora

O superset implementa um hook shell (`notify-hook.sh`) que é injetado via variáveis de ambiente no terminal do AI agent. Isso permite que o AI notifique sobre eventos como `PermissionRequest` (precisa de input do usuário) além de `Stop`.

O Forja já recebe o evento `pty:session-state-changed` (emitido pelo processo Electron quando o PTY fecha), que cobre o caso `Stop`. Para `PermissionRequest`, precisaríamos implementar o hook externo completo — o que é significativo em escopo (modificar `pty.ts`, `preload.ts`, `electron/main.ts` para injetar env vars no spawn, e criar o script hook).

**Decisão**: MVP com `pty:session-state-changed` existente. Hook externo para `PermissionRequest` é uma feature separada futura.

### Por que usar dot no header em vez de CSS ring

`renderValues.headerContent` do FlexLayout não é garantidamente posicionado como `relative` para que um `position: absolute` interno funcione. O `renderValues.buttons` é o lugar seguro para adicionar elementos visuais ao header do tabset, como demonstrado pelo código existente para o file-tree.

O dot pulsante (`animate-ping`) é visualmente mais discreto e idiomático (padrão adotado pelo superset `StatusIndicator`) do que um ring em torno do tabset inteiro.

### Por que derivar `hasNotifiedTab` via closure em vez de estado dedicado

Adicionar `notifiedTabsets: Set<string>` ao `tiling-layout` store criaria uma dependência bidirecional (tiling → projects) que pode gerar ciclos de atualização. A abordagem de subscrever `notifiedProjects` diretamente no componente `TilingLayout` e derivar quais tabsets mostrar o dot é mais simples, correta e não adiciona estado redundante.

---

## 10. Notas de Implementação

- Os testes de `tiling-layout.tsx` (componente visual) são mais difíceis de testar unitariamente porque dependem do FlexLayout. Focar os testes nas camadas de store e hooks.
- O `onRenderTabSet` é chamado a cada render do FlexLayout — manter a lógica interna rápida (apenas lookup em Sets, sem async).
- A adição de `animate-pulse` ao badge é CSS puro e não precisa de testes específicos além de checar a presença da classe.
- Verificar se existe arquivo de testes para `App.tsx` antes de criar um novo.
