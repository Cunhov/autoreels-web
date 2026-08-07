import { redirect } from 'next/navigation'

// The calendar lives at "/" (CalendarPage in app/page.tsx). This route is kept
// for compatibility and redirects server-side — no client-side flash.
export default function CalendarPage() {
    redirect('/')
}
