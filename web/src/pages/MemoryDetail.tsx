import { useEffect, useState } from "react"
import { useParams, useNavigate, Link } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Clock,
  GitBranch,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
} from "lucide-react"
import { toast } from "sonner"
import { getMemory, getVersions, getRelated, updateMemory, deleteMemory } from "@/api/client"
import { getOrComputeDiff, sweepExpiredDiffCache } from "@/lib/diff-cache"
import type { Memory, VersionRecord, SearchResult } from "@/types"

export function MemoryDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [memory, setMemory] = useState<Memory | null>(null)
  const [versions, setVersions] = useState<VersionRecord[]>([])
  const [currentVersion, setCurrentVersion] = useState(0)
  const [related, setRelated] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({})

  // Inline Edit state
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editContent, setEditContent] = useState("")
  const [editScope, setEditScope] = useState<Memory["scope"]>("project")
  const [editNamespace, setEditNamespace] = useState("")
  const [editDocType, setEditDocType] = useState("")
  const [editTags, setEditTags] = useState("")
  const [editImportance, setEditImportance] = useState("0.5")
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState("content")

  const initEditState = (m: Memory) => {
    setEditTitle(m.title ?? "")
    setEditContent(m.content)
    setEditScope(m.scope)
    setEditNamespace(m.namespace ?? "")
    setEditDocType(m.document_type ?? "")
    setEditTags(m.tags?.join(", ") ?? "")
    setEditImportance(String(m.importance_score ?? 0.5))
  }

  useEffect(() => {
    sweepExpiredDiffCache()
  }, [])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      getMemory(id, true),
      getVersions(id),
      getRelated(id, 8),
    ])
      .then(([memData, verData, relData]) => {
        setMemory(memData.memory)
        initEditState(memData.memory)
        setVersions(verData.history)
        setCurrentVersion(verData.current_version)
        setRelated(relData.related)
      })
      .finally(() => setLoading(false))
  }, [id])

  const startEditing = () => {
    if (memory) {
      initEditState(memory)
      setIsEditing(true)
      setActiveTab("content")
    }
  }

  const cancelEditing = () => {
    if (memory) {
      initEditState(memory)
    }
    setIsEditing(false)
  }

  const handleSave = async () => {
    if (!id) return
    setSaving(true)
    try {
      const parsedTags = editTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      const parsedImp = Number.parseFloat(editImportance)

      const result = await updateMemory(id, {
        title: editTitle.trim() || undefined,
        content: editContent,
        scope: editScope,
        namespace: editNamespace.trim() || null,
        document_type: editDocType.trim() || null,
        tags: parsedTags,
        importance_score: isNaN(parsedImp) ? undefined : Math.min(1, Math.max(0, parsedImp)),
      })
      setMemory(result.memory)
      initEditState(result.memory)
      setIsEditing(false)
      // refresh version history
      const verData = await getVersions(id)
      setVersions(verData.history)
      setCurrentVersion(verData.current_version)
      toast.success("Memory updated successfully")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!id || !confirm("Delete this memory? This cannot be undone.")) return
    try {
      await deleteMemory(id)
      toast.success("Memory deleted")
      navigate("/browse")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed")
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!memory) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Memory not found</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/browse")}>
          Back to Browse
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate(-1)} className="mb-2 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="font-display text-3xl italic">
            {memory.title || "Untitled Memory"}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{memory.scope}</Badge>
            {memory.namespace && <Badge variant="secondary">{memory.namespace}</Badge>}
            {memory.document_type && <Badge>{memory.document_type}</Badge>}
            <span className="text-xs text-muted-foreground">
              v{currentVersion} · Updated {new Date(memory.updated_at).toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                <Check className="mr-1 h-4 w-4" />
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelEditing} disabled={saving}>
                <X className="mr-1 h-4 w-4" />
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={startEditing}>
              <Pencil className="mr-1 h-4 w-4" />
              Edit
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isEditing || saving}>
            <Trash2 className="mr-1 h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Tabs: Content | Versions | Related | Metadata */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v ?? "content")}>
        <TabsList>
          <TabsTrigger value="content">
            {isEditing ? "Content (Editing)" : "Content"}
          </TabsTrigger>
          <TabsTrigger value="versions">
            <Clock className="mr-1 h-4 w-4" />
            Versions ({versions.length})
          </TabsTrigger>
          <TabsTrigger value="related">
            <GitBranch className="mr-1 h-4 w-4" />
            Related ({related.length})
          </TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-4">
          <Card>
            <CardContent className="p-6">
              {isEditing ? (
                <div className="space-y-4">
                  {/* Compact Field Bar */}
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <label className="microlabel text-[11px]">Title</label>
                        <Input
                          placeholder="Memory Title"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="microlabel text-[11px]">Scope</label>
                          <Select value={editScope} onValueChange={(v) => v && setEditScope(v as Memory["scope"])}>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Scope" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="global">global</SelectItem>
                              <SelectItem value="project">project</SelectItem>
                              <SelectItem value="user">user</SelectItem>
                              <SelectItem value="team">team</SelectItem>
                              <SelectItem value="department">department</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <label className="microlabel text-[11px]">Namespace</label>
                          <Input
                            placeholder="e.g. hyprland, nitro"
                            value={editNamespace}
                            onChange={(e) => setEditNamespace(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <label className="microlabel text-[11px]">Document Type</label>
                        <Input
                          placeholder="e.g. decision, lesson, code"
                          value={editDocType}
                          onChange={(e) => setEditDocType(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="microlabel text-[11px]">Tags (comma-separated)</label>
                        <Input
                          placeholder="e.g. arch, hyprland, ui"
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="microlabel text-[11px]">Quality / Importance (0.0 - 1.0)</label>
                        <Input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1"
                          placeholder="0.5"
                          value={editImportance}
                          onChange={(e) => setEditImportance(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Inline Content Editor */}
                  <div className="space-y-1.5">
                    <label className="microlabel text-[11px]">Content (Markdown / Text)</label>
                    <Textarea
                      placeholder="Memory content..."
                      className="min-h-[360px] font-mono text-sm leading-relaxed"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                  </div>

                  {/* Inline Action Bar */}
                  <div className="flex items-center justify-end gap-2 pt-2 border-t">
                    <Button variant="outline" size="sm" onClick={cancelEditing} disabled={saving}>
                      <X className="mr-1 h-4 w-4" />
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      <Check className="mr-1 h-4 w-4" />
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                  {memory.content}
                </pre>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <div className="space-y-3">
            {versions.length === 0 && (
              <p className="text-sm text-muted-foreground">No previous versions</p>
            )}
            {versions.map((v, index) => {
              // Compare v with the version immediately newer than it (or current memory if it is the latest past version)
              const nextVersion = index === 0 ? memory : versions[index - 1]
              const oldText = v.content
              const newText = nextVersion.content

              // Format metadata JSON for comparison
              const oldMetaStr = v.metadata ? JSON.stringify(JSON.parse(v.metadata), null, 2) : ""
              const newMeta = (nextVersion as any).metadata
              const newMetaStr = newMeta
                ? typeof newMeta === "string"
                  ? JSON.stringify(JSON.parse(newMeta), null, 2)
                  : JSON.stringify(newMeta, null, 2)
                : ""

              // 7-day cached diff calculation with Fast-Path
              const cacheKey = `${memory.id}_v${v.version}_to_${index === 0 ? currentVersion : versions[index - 1].version}`
              const { summary, contentDiff, metaDiff, titleChanged } = getOrComputeDiff(
                cacheKey,
                oldText,
                newText,
                oldMetaStr,
                newMetaStr,
                v.title ?? "",
                nextVersion.title ?? "",
              )

              const isExpanded = !!expandedVersions[v.id]
              const toggleExpand = () => {
                setExpandedVersions((prev) => ({ ...prev, [v.id]: !prev[v.id] }))
              }

              const hasMetaDiff = metaDiff.length > 0
              const hasAnyChange = summary.added > 0 || summary.removed > 0 || hasMetaDiff || titleChanged

              return (
                <Card
                  key={v.id}
                  className="transition-all duration-200 hover:border-primary/40 overflow-hidden"
                >
                  <CardHeader
                    className="cursor-pointer select-none py-3 px-4 hover:bg-muted/40 transition-colors"
                    onClick={toggleExpand}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-primary shrink-0 transition-transform duration-200" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200" />
                        )}
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <span>Version {v.version}</span>
                          <span className="text-xs font-normal text-muted-foreground">
                            → {index === 0 ? `Current (v${currentVersion})` : `v${versions[index - 1].version}`}
                          </span>
                        </CardTitle>
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Diff stats chips */}
                        <div className="flex items-center gap-1.5 font-mono text-xs">
                          {summary.added > 0 && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-green-500/10 px-1.5 py-0.5 font-medium text-green-600 dark:text-green-400">
                              <Plus className="h-3 w-3" />
                              {summary.added}
                            </span>
                          )}
                          {summary.removed > 0 && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-red-500/10 px-1.5 py-0.5 font-medium text-red-600 dark:text-red-400">
                              <Minus className="h-3 w-3" />
                              {summary.removed}
                            </span>
                          )}
                          {titleChanged && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-blue-500 border-blue-500/30">
                              title
                            </Badge>
                          )}
                          {hasMetaDiff && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-amber-500 border-amber-500/30">
                              metadata
                            </Badge>
                          )}
                          {!hasAnyChange && (
                            <span className="text-muted-foreground text-[11px]">Metadata / settings update</span>
                          )}
                        </div>

                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(v.changed_at).toLocaleString()}
                          {v.changed_by && ` · ${v.changed_by}`}
                        </span>
                      </div>
                    </div>

                    {/* Collapsed 2-line snippet preview */}
                    {!isExpanded && (
                      <div className="mt-2 pl-6">
                        <pre className="line-clamp-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground/70 leading-relaxed">
                          {v.content}
                        </pre>
                      </div>
                    )}
                  </CardHeader>

                  {isExpanded && (
                    <CardContent className="border-t p-0 animate-in fade-in slide-in-from-top-1 duration-200">
                      {/* Title Diff if changed (GitHub diff style) */}
                      {titleChanged && (
                        <div className="border-b divide-y divide-border/30 font-mono text-xs leading-5">
                          <div className="bg-muted/40 px-4 py-1.5 text-[11px] font-medium text-muted-foreground flex items-center justify-between">
                            <span>Title Diff</span>
                            <span className="text-[10px] text-blue-500 font-semibold uppercase tracking-wider">renamed</span>
                          </div>
                          <div className="flex bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-0.5">
                            <span className="select-none w-6 text-red-600 dark:text-red-400 shrink-0 text-center font-bold">
                              -
                            </span>
                            <span className="whitespace-pre-wrap break-all flex-1">
                              {v.title || "(Untitled)"}
                            </span>
                          </div>
                          <div className="flex bg-green-500/10 text-green-700 dark:text-green-300 px-4 py-0.5">
                            <span className="select-none w-6 text-green-600 dark:text-green-400 shrink-0 text-center font-bold">
                              +
                            </span>
                            <span className="whitespace-pre-wrap break-all flex-1">
                              {nextVersion.title || "(Untitled)"}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* GitHub style content diff view */}
                      <div className="divide-y divide-border/40 font-mono text-xs leading-5">
                        <div className="bg-muted/40 px-4 py-1.5 text-[11px] font-medium text-muted-foreground flex items-center justify-between">
                          <span>Content Diff</span>
                          <span>
                            {summary.added > 0 || summary.removed > 0
                              ? `+${summary.added} / -${summary.removed} lines`
                              : "No content changes"}
                          </span>
                        </div>
                        {summary.added === 0 && summary.removed === 0 ? (
                          <div className="px-4 py-3 text-xs text-muted-foreground italic bg-muted/5">
                            Content is identical between these revisions.
                          </div>
                        ) : (
                          <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                            {contentDiff.map((line, lIdx) => {
                              if (line.type === "add") {
                                return (
                                  <div
                                    key={lIdx}
                                    className="flex bg-green-500/10 text-green-700 dark:text-green-300 px-4 py-0.5"
                                  >
                                    <span className="select-none w-6 text-green-600 dark:text-green-400 shrink-0 text-center font-bold">
                                      +
                                    </span>
                                    <span className="whitespace-pre-wrap break-all flex-1">
                                      {line.line}
                                    </span>
                                  </div>
                                )
                              }
                              if (line.type === "del") {
                                return (
                                  <div
                                    key={lIdx}
                                    className="flex bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-0.5"
                                  >
                                    <span className="select-none w-6 text-red-600 dark:text-red-400 shrink-0 text-center font-bold">
                                      -
                                    </span>
                                    <span className="whitespace-pre-wrap break-all flex-1">
                                      {line.line}
                                    </span>
                                  </div>
                                )
                              }
                              return (
                                <div
                                  key={lIdx}
                                  className="flex text-muted-foreground/80 hover:bg-muted/20 px-4 py-0.5"
                                >
                                  <span className="select-none w-6 shrink-0 text-center opacity-30">
                                    {" "}
                                  </span>
                                  <span className="whitespace-pre-wrap break-all flex-1">
                                    {line.line}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* Metadata Diff Section */}
                        {hasMetaDiff && (
                          <div>
                            <div className="bg-muted/60 px-4 py-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400 flex items-center justify-between border-t">
                              <span>Metadata Changes</span>
                              <span>JSON Diff</span>
                            </div>
                            <div className="overflow-x-auto max-h-[300px] overflow-y-auto bg-muted/10">
                              {metaDiff.map((line, mIdx) => {
                                if (line.type === "add") {
                                  return (
                                    <div
                                      key={mIdx}
                                      className="flex bg-green-500/10 text-green-700 dark:text-green-300 px-4 py-0.5"
                                    >
                                      <span className="select-none w-6 text-green-600 dark:text-green-400 shrink-0 text-center font-bold">
                                        +
                                      </span>
                                      <span className="whitespace-pre-wrap break-all flex-1">
                                        {line.line}
                                      </span>
                                    </div>
                                  )
                                }
                                if (line.type === "del") {
                                  return (
                                    <div
                                      key={mIdx}
                                      className="flex bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-0.5"
                                    >
                                      <span className="select-none w-6 text-red-600 dark:text-red-400 shrink-0 text-center font-bold">
                                        -
                                      </span>
                                      <span className="whitespace-pre-wrap break-all flex-1">
                                        {line.line}
                                      </span>
                                    </div>
                                  )
                                }
                                return (
                                  <div
                                    key={mIdx}
                                    className="flex text-muted-foreground/80 hover:bg-muted/20 px-4 py-0.5"
                                  >
                                    <span className="select-none w-6 shrink-0 text-center opacity-30">
                                      {" "}
                                    </span>
                                    <span className="whitespace-pre-wrap break-all flex-1">
                                      {line.line}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  )}
                </Card>
              )
            })}
          </div>
        </TabsContent>

        <TabsContent value="related" className="mt-4">
          <div className="space-y-3">
            {related.length === 0 && (
              <p className="text-sm text-muted-foreground">No related memories found</p>
            )}
            {related.map((r) => (
              <Link key={r.memory.id} to={`/memory/${r.memory.id}`}>
                <Card className="transition-colors hover:bg-accent/50">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {r.memory.title || r.memory.content.slice(0, 80)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.memory.scope}/{r.memory.namespace}
                      </p>
                    </div>
                    <Badge variant="secondary" className="ml-3">
                      {(r.score * 100).toFixed(0)}% similar
                    </Badge>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="metadata" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {[
                  ["ID", memory.id],
                  ["Scope", memory.scope],
                  ["Namespace", memory.namespace],
                  ["Document Type", memory.document_type],
                  ["Source", memory.source],
                  ["Author", memory.author],
                  ["Department", memory.department],
                  ["Access Level", memory.access_level],
                  ["Language", memory.language],
                  ["Created", new Date(memory.created_at).toLocaleString()],
                  ["Updated", new Date(memory.updated_at).toLocaleString()],
                  ["Expires", memory.expires_at ? new Date(memory.expires_at).toLocaleString() : null],
                  ["Access Count", memory.access_count],
                  ["Importance", `${(memory.importance_score * 100).toFixed(0)}%`],
                  ["Confidence", `${(memory.confidence_score * 100).toFixed(0)}%`],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-medium">{value ?? "—"}</dd>
                  </div>
                ))}
              </dl>
              {memory.tags.length > 0 && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">Tags</p>
                    <div className="flex flex-wrap gap-1">
                      {memory.tags.map((tag) => (
                        <Badge key={tag} variant="outline">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {memory.metadata && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">Custom Metadata</p>
                    <pre className="rounded bg-muted p-3 text-xs">
                      {JSON.stringify(memory.metadata, null, 2)}
                    </pre>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
