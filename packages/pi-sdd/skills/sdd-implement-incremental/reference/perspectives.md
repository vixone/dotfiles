# Implementation perspectives

Select only perspectives needed by the current phase and use configured model roles:

| Perspective | Public context | Outputs |
|---|---|---|
| Feature | Domain rules and acceptance | Models, services, algorithms |
| API | Interface contracts and error behavior | Routes, DTOs, middleware |
| UI | Interaction/accessibility requirements | Components and state handling |
| Tests | Public behavioral requirements | Unit/integration tests and fixtures |
| Docs | Approved documentation scope | README/API comments |
| Infrastructure | Reviewed local configuration contract | Migration/CI/container files only |

Infrastructure perspective does not authorize deployment or live apply. All coding workers receive exact file scopes and test commands, no holdouts or parent transcript. Research/review context is explicitly selected; workers have no automatic skills, web, MCP or nested-worker capability.
