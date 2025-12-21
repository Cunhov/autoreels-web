'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import IOSButton from '@/components/IOSButton'
import { IOSInputRow, IOSGroup } from '@/components/IOSComponents'

export default function Login() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const router = useRouter()

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        })

        if (error) {
            setError(error.message)
            setLoading(false)
        } else {
            router.push('/')
            router.refresh()
        }
    }

    return (
        <div className="flex flex-col items-center justify-center min-h-[80vh] w-full max-w-md mx-auto p-4">
            <div className="w-full mb-10 text-center">
                <h1 className="text-[34px] font-bold text-ios-text tracking-tight">AutoReels</h1>
                <p className="text-ios-text-secondary mt-2">Sign in to manage your reels</p>
            </div>

            <form onSubmit={handleLogin} className="w-full">
                <IOSGroup header="Credentials">
                    <IOSInputRow
                        label="Email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                    />
                    <IOSInputRow
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Required"
                    />
                </IOSGroup>

                {error && (
                    <div className="mb-6 p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
                        {error}
                    </div>
                )}

                <div className="space-y-4">
                    <IOSButton type="submit" disabled={loading} className='shadow-lg'>
                        {loading ? 'Signing in...' : 'Sign In'}
                    </IOSButton>

                    <Link href="/signup" className="block text-center text-ios-blue text-[15px]">
                        Create an account
                    </Link>
                </div>
            </form>
        </div>
    )
}
