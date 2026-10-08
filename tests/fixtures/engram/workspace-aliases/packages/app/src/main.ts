import { total } from '@mono/core'
import { z } from 'zod'
import { format } from '@/format'

export const line = format(total([1, 2]))
export const schema = z.string()
