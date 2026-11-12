// Package health runs service health checks: TCP (the default), HTTP and
// command probes, with interval, timeout, start period and failure
// threshold from the ServiceSpec. Deploys wait on it before switching
// traffic, and status changes become HealthChanged events.
//
// Not to be confused with package nodecheck, the node-level "Health check"
// shown with the heart icon in the panel.
//
// Interfaces used by other packages:
//
//   - Prober: reconcile probes new generations during deploys and watches
//     running instances. Probes (NewProber) is the implementation; its
//     WaitHealthy returns a *NotListeningError when the default check was
//     refused all along, which the deploy error follows with a hint.
//   - Watch: turns probe results of a running instance into a HealthState
//     (start period, failure threshold).
package health
