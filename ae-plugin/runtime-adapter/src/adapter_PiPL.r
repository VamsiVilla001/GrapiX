#include "AEConfig.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif

/* GrapiX runtime adapter — AE-A0 spike.
 * Internal identifiers keep "AE"; the customer-facing product name is cleared separately
 * (see docs/ae-runtime-licensing-decision-request.md §9.2 condition 5). */
resource 'PiPL' (16000) {
	{
		Kind {
			AEGP
		},
		Name {
			"GrapiX Runtime Adapter"
		},
		Category {
			"General Plugin"
		},
		Version {
			65536
		},
#ifdef AE_OS_WIN
	#if defined(AE_PROC_INTELx64)
		CodeWin64X86 {"EntryPointFunc"},
	#elif defined(AE_PROC_ARM64)
		CodeWinARM64 {"EntryPointFunc"},
	#endif
#elif defined(AE_OS_MAC)
		CodeMacIntel64 {"EntryPointFunc"},
		CodeMacARM64 {"EntryPointFunc"},
#endif
	}
};
