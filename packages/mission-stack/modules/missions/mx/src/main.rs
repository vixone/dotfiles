use clap::{Parser, Subcommand};

use mx::cmd_read::{self, ChildrenArgs, HistoryArgs, ListArgs, ReadyArgs, SearchArgs, ShowArgs};
use mx::cmd_memory::{self, KeyArgs, MemoriesArgs, RememberArgs};
use mx::cmd_export::{self, ExportArgs};
use mx::cmd_import::{self, ImportArgs};
use mx::cmd_close::{self, CloseArgs, ReopenArgs};
use mx::cmd_write::{self, CreateArgs, DeleteArgs, DepAddArgs, LinkArgs, TextArgs, UpdateArgs};
use mx::error;
use mx::store::Store;

#[derive(Parser)]
#[command(name = "mx", version, about = "Mission store CLI (bd-compatible subset)")]
struct Cli {
    /// Emit JSON instead of text.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print the mx version.
    Version,
    /// Create an issue.
    Create(CreateArgs),
    /// Update one or more issues.
    Update(UpdateArgs),
    /// Append to an issue's notes.
    Note(TextArgs),
    /// Add a comment to an issue.
    Comment(TextArgs),
    /// Manage dependencies.
    Dep {
        #[command(subcommand)]
        command: DepCommand,
    },
    /// Link two issues (id2 blocks id1, or --type relates_to).
    Link(LinkArgs),
    /// Delete issues (preview unless --force).
    Delete(DeleteArgs),
    /// Close issues (batch ordered by dependencies).
    #[command(alias = "done")]
    Close(CloseArgs),
    /// Reopen closed issues.
    Reopen(ReopenArgs),
    /// List issues (default: not closed).
    List(ListArgs),
    /// Show issue details.
    Show(ShowArgs),
    /// Direct children of an issue.
    Children(ChildrenArgs),
    /// Open issues with no open blockers.
    Ready(ReadyArgs),
    /// Search titles and ids.
    Search(SearchArgs),
    /// Event log of an issue.
    History(HistoryArgs),
    /// Store a lesson (key defaults to a slug of the text).
    Remember(RememberArgs),
    /// List lessons, optionally filtered.
    Memories(MemoriesArgs),
    /// Print one lesson's text.
    Recall(KeyArgs),
    /// Delete a lesson.
    Forget(KeyArgs),
    /// Dump issues and memories as JSON lines.
    Export(ExportArgs),
    /// One-shot import from a beads (Dolt) store.
    Import(ImportArgs),
}

#[derive(Subcommand)]
enum DepCommand {
    /// ISSUE is blocked by DEPENDS_ON.
    Add(DepAddArgs),
}

fn main() {
    let cli = Cli::parse();
    if let Err(err) = run(cli) {
        eprintln!("Error: {err:#}");
        std::process::exit(error::code_of(&err));
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let json = cli.json;
    if let Command::Version = cli.command {
        let version = env!("CARGO_PKG_VERSION");
        if json {
            let out = serde_json::json!({
                "version": version,
                "schema_version": mx::store::SCHEMA_VERSION,
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        } else {
            println!("mx version {version}");
        }
        return Ok(());
    }

    let mut store = Store::open_default()?;
    match cli.command {
        Command::Version => unreachable!(),
        Command::Create(a) => cmd_write::create(&mut store, a, json),
        Command::Update(a) => cmd_write::update(&mut store, a, json),
        Command::Note(a) => cmd_write::note(&mut store, a, json),
        Command::Comment(a) => cmd_write::comment(&mut store, a, json),
        Command::Dep { command: DepCommand::Add(a) } => cmd_write::dep_add(&mut store, a, json),
        Command::Link(a) => cmd_write::link(&mut store, a, json),
        Command::Delete(a) => cmd_write::delete(&mut store, a, json),
        Command::Close(a) => cmd_close::close(&mut store, a, json),
        Command::Reopen(a) => cmd_close::reopen(&mut store, a, json),
        Command::List(a) => cmd_read::list(&store, a, json),
        Command::Show(a) => cmd_read::show(&store, a, json),
        Command::Children(a) => cmd_read::children(&store, a, json),
        Command::Ready(a) => cmd_read::ready(&store, a, json),
        Command::Search(a) => cmd_read::search(&store, a, json),
        Command::History(a) => cmd_read::history(&store, a, json),
        Command::Remember(a) => cmd_memory::remember(&mut store, a, json),
        Command::Memories(a) => cmd_memory::memories(&store, a, json),
        Command::Recall(a) => cmd_memory::recall(&store, a, json),
        Command::Forget(a) => cmd_memory::forget(&mut store, a, json),
        Command::Export(a) => cmd_export::export(&store, a, json),
        Command::Import(a) => cmd_import::import(&mut store, a, json),
    }
}
